/**
 * catalog.js v6
 *
 * Key fixes vs v5:
 *
 * 1. ARTIST FALLBACK — When a source has artist_lock, we no longer require
 *    "Originally Performed By X" to be embedded in the Deezer title.
 *    Instead: try extractOriginalArtist() first; if it fails, use artist_lock
 *    as the artist directly. This is safe because artist_lock sources are
 *    already scoped to a single artist by their search query.
 *
 * 2. PRE-SEEDED RELEASE YEARS — MusicBrainz at 1 req/s made ingesting
 *    300 songs take 5+ minutes, causing Render free-tier timeouts. Instead
 *    we maintain a hand-curated table of known artist→song→year mappings
 *    for the most popular songs, and use MusicBrainz only for songs NOT in
 *    the table. MusicBrainz lookups are still done but are skipped if a
 *    year is already known, dramatically cutting the number of calls.
 *
 * 3. PARALLEL DEDUP — ON CONFLICT DO NOTHING handles duplicate songs across
 *    multiple query variations for the same artist.
 */

const pool = require('./db');

// ─── Instrumental keyword filter ──────────────────────────────────────────────
const INSTRUMENTAL_KEYWORDS = [
  'instrumental', 'karaoke', 'backing track', 'backing version',
  'minus one', 'no vocal', 'no voice', 'music only',
  'piano version', 'orchestra version', 'orchestral version',
  'acoustic instrumental', 'in the style of', 'tribute instrumental',
];
function isInstrumental(track) {
  const v = (track.title_version || '').toLowerCase();
  const t = (track.title        || '').toLowerCase();
  return INSTRUMENTAL_KEYWORDS.some(kw => v.includes(kw) || t.includes(kw));
}

// ─── Mashup / compilation rejection ──────────────────────────────────────────
const REJECT_PATTERNS = [
  /\bmedley\b/i, /\bmegamix\b/i, /\bmashup\b/i, /\bmash.?up\b/i,
  /\bcollection\b/i, /\bcompilation\b/i,
  /\d+\s+(hits|songs|classics)\s+in\s+\d+/i,
  /\bnon.?stop\b/i, /\bparty\s+mix\b/i, /\bkaraoke\s+megamix\b/i,
];
function isRejectedTitle(title) {
  return REJECT_PATTERNS.some(p => p.test(title));
}

function hasSensibleDuration(track) {
  const d = track.duration || 0;
  return d >= 60 && d <= 600;
}

// ─── Title cleaning ───────────────────────────────────────────────────────────
const TITLE_STRIP = [
  /\s*\(originally performed by[^)]*\)/gi,
  /\s*\(originally recorded by[^)]*\)/gi,
  /\s*\(originally popularized by[^)]*\)/gi,
  /\s*\(made famous by[^)]*\)/gi,
  /\s*\(as made famous by[^)]*\)/gi,
  /\s*\(as performed by[^)]*\)/gi,
  /\s*\(in the style of[^)]*\)/gi,
  /\s*\(tribute to[^)]*\)/gi,
  /\s*\(karaoke[^)]*\)/gi,
  /\s*\(instrumental[^)]*\)/gi,
  /\s*\(backing track[^)]*\)/gi,
  /\s*\(piano[^)]*\)/gi,
  /\s*\(minus one[^)]*\)/gi,
  /\s*\(no vocal[^)]*\)/gi,
  /\s*\(cover[^)]*\)/gi,
  /\s*\(without vocals[^)]*\)/gi,
  /\s*\[originally[^\]]*\]/gi,
  /\s*\[in the style[^\]]*\]/gi,
  /\s*\[karaoke[^\]]*\]/gi,
  /\s*\[instrumental[^\]]*\]/gi,
  /\s*[-\u2013]\s*(karaoke|instrumental|backing track|piano version|minus one|in the style of)[^\n]*/gi,
  /^(instrumental|karaoke)[:\s]+/gi,
];
function cleanTitle(raw) {
  let s = raw || '';
  for (const p of TITLE_STRIP) s = s.replace(p, '');
  return s.trim();
}
function extractRealTitle(track) {
  const shortClean = cleanTitle(track.title_short || '');
  if (shortClean.length > 1) return shortClean;
  return cleanTitle(track.title || '');
}

// ─── Artist extraction from title ────────────────────────────────────────────
// Only used when no artist_lock is present. With artist_lock, the locked
// artist name IS the artist — we don't need to parse it from the title.
const ARTIST_PATTERNS = [
  /originally performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally recorded by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally popularized by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /originally by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /made famous by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /as made famous by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /as performed by\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /in the style of\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /tribute to\s+([^)([\]\n]+?)(?:\s*[\(\[]|$)/i,
  /\[([^\]]+?)\s+karaoke]/i,
  /\(([^)]+?)\s+karaoke\)/i,
];
function extractOriginalArtist(track) {
  const fullTitle = track.title || '';
  for (const pattern of ARTIST_PATTERNS) {
    const m = fullTitle.match(pattern);
    if (m) {
      const artist = m[1]
        .replace(/\s*[-\u2013]\s*(karaoke|instrumental|version|track|vocal).*/i, '')
        .replace(/\s*\(.*\)$/, '')
        .trim();
      if (artist.length > 1 && artist.length < 60) return artist;
    }
  }
  return null;
}

// ─── Artist normaliser ────────────────────────────────────────────────────────
function normArtist(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bthe\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Pre-seeded release year table ───────────────────────────────────────────
// Maps "lower(title)||lower(artist)" → original release year.
// Populated for the most common songs from locked artists so we rarely need
// to hit MusicBrainz at runtime. MusicBrainz is still called for songs
// NOT in this table.
//
// Format: ['Song Title', 'Artist', year]
// Keep this sorted by artist for readability.
const KNOWN_YEARS = [
  // ABBA
  ['Dancing Queen', 'ABBA', 1976], ['Mamma Mia', 'ABBA', 1975],
  ['Fernando', 'ABBA', 1976], ['Waterloo', 'ABBA', 1974],
  ['The Winner Takes It All', 'ABBA', 1980], ['Gimme! Gimme! Gimme!', 'ABBA', 1979],
  ['Voulez-Vous', 'ABBA', 1979], ['Super Trouper', 'ABBA', 1980],
  ['Knowing Me Knowing You', 'ABBA', 1977], ['Take a Chance on Me', 'ABBA', 1978],

  // Adele
  ['Hello', 'Adele', 2015], ['Rolling in the Deep', 'Adele', 2010],
  ['Someone Like You', 'Adele', 2011], ['Set Fire to the Rain', 'Adele', 2011],
  ['Skyfall', 'Adele', 2012], ['Easy On Me', 'Adele', 2021],
  ['Chasing Pavements', 'Adele', 2008], ['Rumour Has It', 'Adele', 2011],
  ['When We Were Young', 'Adele', 2015], ['Send My Love', 'Adele', 2016],
  ['Water Under the Bridge', 'Adele', 2015], ['Oh My God', 'Adele', 2021],
  ['I Drink Wine', 'Adele', 2021], ['Hold On', 'Adele', 2021],
  // Adele — additional songs & alternate title spellings used by Deezer publishers
  ['Turning Tables', 'Adele', 2011], ['Lovesong', 'Adele', 2011],
  ['Love Song', 'Adele', 2011], ['Hometown Glory', 'Adele', 2007],
  ['Make You Feel My Love', 'Adele', 2008], ['One and Only', 'Adele', 2011],
  ['Million Years Ago', 'Adele', 2015], ['All I Ask', 'Adele', 2015],
  ['River Lea', 'Adele', 2015], ['Sweetest Devotion', 'Adele', 2015],
  ['Remedy', 'Adele', 2015], ['Cold Shoulder', 'Adele', 2008],
  ['Right as Rain', 'Adele', 2008], ['Crazy for You', 'Adele', 2008],
  ['Daydreamer', 'Adele', 2008], [`Don't You Remember`, 'Adele', 2011],
  ['Take It All', 'Adele', 2011], ['To Be Loved', 'Adele', 2021],
  ['Can I Get It', 'Adele', 2021], ['Love Is a Game', 'Adele', 2021],
  ['Cry Your Heart Out', 'Adele', 2021], ['Strangers by Nature', 'Adele', 2021],

  // Ariana Grande
  ['Thank U Next', 'Ariana Grande', 2018], ['7 Rings', 'Ariana Grande', 2019],
  ['Problem', 'Ariana Grande', 2014], ['Into You', 'Ariana Grande', 2016],
  ['No Tears Left to Cry', 'Ariana Grande', 2018], ['God Is a Woman', 'Ariana Grande', 2018],
  ['Side to Side', 'Ariana Grande', 2016], ['Positions', 'Ariana Grande', 2020],
  ['34+35', 'Ariana Grande', 2020], ['Break Free', 'Ariana Grande', 2014],

  // Beyoncé
  ['Crazy in Love', 'Beyonce', 2003], ['Halo', 'Beyonce', 2008],
  ['Single Ladies', 'Beyonce', 2008], ['Irreplaceable', 'Beyonce', 2006],
  ['Lemonade', 'Beyonce', 2016], ['Formation', 'Beyonce', 2016],

  // Billie Eilish
  ['Bad Guy', 'Billie Eilish', 2019], ['Happier Than Ever', 'Billie Eilish', 2021],
  ['Ocean Eyes', 'Billie Eilish', 2016], ['Everything I Wanted', 'Billie Eilish', 2019],
  ['Therefore I Am', 'Billie Eilish', 2020], ['Lovely', 'Billie Eilish', 2018],
  ['Birds of a Feather', 'Billie Eilish', 2024], ['What Was I Made For?', 'Billie Eilish', 2023],
  ['Wish You Were Gay', 'Billie Eilish', 2019], ['Bellyache', 'Billie Eilish', 2017],

  // Bruno Mars
  ['Uptown Funk', 'Bruno Mars', 2014], ['Just the Way You Are', 'Bruno Mars', 2010],
  ['Grenade', 'Bruno Mars', 2010], ['Locked Out of Heaven', 'Bruno Mars', 2012],
  ['24K Magic', 'Bruno Mars', 2016], ['Count on Me', 'Bruno Mars', 2010],
  ['The Lazy Song', 'Bruno Mars', 2010], ['Treasure', 'Bruno Mars', 2013],
  ['When I Was Your Man', 'Bruno Mars', 2012], [`That\'s What I Like`, 'Bruno Mars', 2016],

  // Coldplay
  ['Yellow', 'Coldplay', 2000], ['The Scientist', 'Coldplay', 2002],
  ['Fix You', 'Coldplay', 2005], ['Clocks', 'Coldplay', 2002],
  ['A Sky Full of Stars', 'Coldplay', 2014], ['Magic', 'Coldplay', 2014],
  ['Paradise', 'Coldplay', 2011], ['Viva la Vida', 'Coldplay', 2008],
  ['Speed of Sound', 'Coldplay', 2005], ['In My Place', 'Coldplay', 2002],

  // Dolly Parton
  ['Jolene', 'Dolly Parton', 1973], ['I Will Always Love You', 'Dolly Parton', 1973],
  ['9 to 5', 'Dolly Parton', 1980], ['Coat of Many Colors', 'Dolly Parton', 1971],

  // Drake
  [`God\'s Plan`, 'Drake', 2018], ['Hotline Bling', 'Drake', 2015],
  ['One Dance', 'Drake', 2016], ['Started From the Bottom', 'Drake', 2013],
  [`Hold On We\'re Going Home`, 'Drake', 2013],

  // Dua Lipa
  ['Levitating', 'Dua Lipa', 2020], [`Don\'t Start Now`, 'Dua Lipa', 2019],
  ['New Rules', 'Dua Lipa', 2017], ['Physical', 'Dua Lipa', 2020],
  ['Blow Your Mind', 'Dua Lipa', 2016], ['Be the One', 'Dua Lipa', 2015],
  ['Break My Heart', 'Dua Lipa', 2020], ['One Kiss', 'Dua Lipa', 2018],
  ['IDGAF', 'Dua Lipa', 2018], ['Houdini', 'Dua Lipa', 2023],

  // Ed Sheeran
  ['Shape of You', 'Ed Sheeran', 2017], ['Thinking Out Loud', 'Ed Sheeran', 2014],
  ['Perfect', 'Ed Sheeran', 2017], ['Photograph', 'Ed Sheeran', 2014],
  ['Bad Habits', 'Ed Sheeran', 2021], ['Shivers', 'Ed Sheeran', 2021],
  ['Castle on the Hill', 'Ed Sheeran', 2017], ['Galway Girl', 'Ed Sheeran', 2017],
  ['Happier', 'Ed Sheeran', 2017], ['A-Team', 'Ed Sheeran', 2011],
  ['Overpass Graffiti', 'Ed Sheeran', 2021], ['The Joker and the Queen', 'Ed Sheeran', 2022],

  // Elton John
  ['Rocket Man', 'Elton John', 1972], ['Tiny Dancer', 'Elton John', 1971],
  ['Crocodile Rock', 'Elton John', 1972], ['Your Song', 'Elton John', 1970],
  [`Don\'t Let the Sun Go Down on Me`, 'Elton John', 1974],
  [`I\'m Still Standing`, 'Elton John', 1983], [`Saturday Night\'s Alright`, 'Elton John', 1973],
  ['Bennie and the Jets', 'Elton John', 1973], ['Candle in the Wind', 'Elton John', 1973],

  // Eminem
  ['Lose Yourself', 'Eminem', 2002], ['Without Me', 'Eminem', 2002],
  ['Slim Shady', 'Eminem', 1999], ['Stan', 'Eminem', 2000],
  ['Not Afraid', 'Eminem', 2010], ['The Real Slim Shady', 'Eminem', 2000],
  ['Love the Way You Lie', 'Eminem', 2010], ['Rap God', 'Eminem', 2013],

  // Garth Brooks
  ['Friends in Low Places', 'Garth Brooks', 1990], ['The Dance', 'Garth Brooks', 1990],
  ['Thunder Rolls', 'Garth Brooks', 1990], [`Ain\'t Going Down`, 'Garth Brooks', 1993],

  // Harry Styles
  ['Watermelon Sugar', 'Harry Styles', 2019], ['As It Was', 'Harry Styles', 2022],
  ['Adore You', 'Harry Styles', 2019], ['Golden', 'Harry Styles', 2020],
  ['Late Night Talking', 'Harry Styles', 2022], ['Matilda', 'Harry Styles', 2022],

  // Johnny Cash
  ['Ring of Fire', 'Johnny Cash', 1963], ['Folsom Prison Blues', 'Johnny Cash', 1955],
  ['Walk the Line', 'Johnny Cash', 1956], ['Hurt', 'Johnny Cash', 2002],
  ['Man in Black', 'Johnny Cash', 1971],

  // Justin Bieber
  ['Baby', 'Justin Bieber', 2010], ['Sorry', 'Justin Bieber', 2015],
  ['Love Yourself', 'Justin Bieber', 2015], ['Peaches', 'Justin Bieber', 2021],
  ['Stay', 'Justin Bieber', 2021], ['Ghost', 'Justin Bieber', 2021],
  ['What Do You Mean?', 'Justin Bieber', 2015], ['Intentions', 'Justin Bieber', 2020],

  // Lady Gaga
  ['Poker Face', 'Lady Gaga', 2008], ['Bad Romance', 'Lady Gaga', 2009],
  ['Just Dance', 'Lady Gaga', 2008], ['Paparazzi', 'Lady Gaga', 2009],
  ['Born This Way', 'Lady Gaga', 2011], ['Shallow', 'Lady Gaga', 2018],
  ['Edge of Glory', 'Lady Gaga', 2011], ['Telephone', 'Lady Gaga', 2009],

  // Mariah Carey
  ['All I Want for Christmas Is You', 'Mariah Carey', 1994],
  ['Hero', 'Mariah Carey', 1993], ['We Belong Together', 'Mariah Carey', 2005],
  ['Fantasy', 'Mariah Carey', 1995], ['Always Be My Baby', 'Mariah Carey', 1995],

  // Olivia Rodrigo
  ['drivers license', 'Olivia Rodrigo', 2021], ['good 4 u', 'Olivia Rodrigo', 2021],
  ['deja vu', 'Olivia Rodrigo', 2021], ['brutal', 'Olivia Rodrigo', 2021],
  ['traitor', 'Olivia Rodrigo', 2021], ['vampire', 'Olivia Rodrigo', 2023],
  ['bad idea right?', 'Olivia Rodrigo', 2023], ['get him back!', 'Olivia Rodrigo', 2023],

  // Queen
  ['Bohemian Rhapsody', 'Queen', 1975], ['We Will Rock You', 'Queen', 1977],
  ['We Are the Champions', 'Queen', 1977], ['Somebody to Love', 'Queen', 1976],
  [`Don\'t Stop Me Now`, 'Queen', 1978], ['Under Pressure', 'Queen', 1981],
  ['Radio Ga Ga', 'Queen', 1984], ['I Want to Break Free', 'Queen', 1984],
  ['Another One Bites the Dust', 'Queen', 1980], ['Killer Queen', 'Queen', 1974],
  ['Bicycle Race', 'Queen', 1978], ['Fat Bottomed Girls', 'Queen', 1978],

  // Rihanna
  ['Umbrella', 'Rihanna', 2007], ['We Found Love', 'Rihanna', 2011],
  ['Diamonds', 'Rihanna', 2012], ['Stay', 'Rihanna', 2012],
  ['Work', 'Rihanna', 2016], ['Only Girl', 'Rihanna', 2010],
  ['Love on the Brain', 'Rihanna', 2016],

  // Shania Twain
  ['Man! I Feel Like a Woman!', 'Shania Twain', 1999],
  [`You\'re Still the One`, 'Shania Twain', 1998],
  [`That Don\'t Impress Me Much`, 'Shania Twain', 1998],
  ['From This Moment On', 'Shania Twain', 1998],
  ['Forever and for Always', 'Shania Twain', 2002],
  [`I\'m Gonna Getcha Good!`, 'Shania Twain', 2002],
  ['Any Man of Mine', 'Shania Twain', 1995],
  ['Feel Like a Woman', 'Shania Twain', 1999],
  [`Honey I\'m Home`, 'Shania Twain', 1995],
  ['Ka-Ching!', 'Shania Twain', 2002],
  ['Come On Over', 'Shania Twain', 1997],
  ['Whose Bed Have Your Boots Been Under?', 'Shania Twain', 1995],
  ['No One Needs to Know', 'Shania Twain', 1995],

  // Taylor Swift
  ['Shake It Off', 'Taylor Swift', 2014], ['Love Story', 'Taylor Swift', 2008],
  ['Blank Space', 'Taylor Swift', 2014], ['Bad Blood', 'Taylor Swift', 2015],
  ['You Belong With Me', 'Taylor Swift', 2009], ['Wildest Dreams', 'Taylor Swift', 2015],
  ['Style', 'Taylor Swift', 2014], ['Anti-Hero', 'Taylor Swift', 2022],
  ['Cruel Summer', 'Taylor Swift', 2019], ['All Too Well', 'Taylor Swift', 2012],
  ['22', 'Taylor Swift', 2013], ['I Knew You Were Trouble', 'Taylor Swift', 2012],
  ['We Are Never Getting Back Together', 'Taylor Swift', 2012],
  ['Fearless', 'Taylor Swift', 2008], ['Enchanted', 'Taylor Swift', 2010],
  ['Lavender Haze', 'Taylor Swift', 2022], ['Midnight Rain', 'Taylor Swift', 2022],
  ['Karma', 'Taylor Swift', 2022], ['Bejeweled', 'Taylor Swift', 2022],
  ['The 1', 'Taylor Swift', 2020], ['Cardigan', 'Taylor Swift', 2020],

  // The Weeknd
  ['Blinding Lights', 'The Weeknd', 2019], ['Starboy', 'The Weeknd', 2016],
  [`Can\'t Feel My Face`, 'The Weeknd', 2015], ['Save Your Tears', 'The Weeknd', 2020],
  ['The Hills', 'The Weeknd', 2015], ['Earned It', 'The Weeknd', 2015],

  // Whitney Houston
  ['I Will Always Love You', 'Whitney Houston', 1992],
  ['Greatest Love of All', 'Whitney Houston', 1986],
  ['I Wanna Dance with Somebody', 'Whitney Houston', 1987],
  ['Saving All My Love for You', 'Whitney Houston', 1985],
  ['Run to You', 'Whitney Houston', 1992],

  // AC/DC
  ['Highway to Hell', 'AC/DC', 1979], ['Back in Black', 'AC/DC', 1980],
  ['Thunderstruck', 'AC/DC', 1990], ['You Shook Me All Night Long', 'AC/DC', 1980],
  ['TNT', 'AC/DC', 1975], [`Rock and Roll Ain\'t Noise Pollution`, 'AC/DC', 1980],

  // Aerosmith
  ['Dream On', 'Aerosmith', 1973], ['Sweet Emotion', 'Aerosmith', 1975],
  ['Walk This Way', 'Aerosmith', 1975], [`I Don\'t Want to Miss a Thing`, 'Aerosmith', 1998],
  [`Livin\' on the Edge`, 'Aerosmith', 1993], [`Cryin\'`, 'Aerosmith', 1993],
  ['Crazy', 'Aerosmith', 1994], ['Amazing', 'Aerosmith', 1993],

  // Alicia Keys
  [`Fallin\'`, 'Alicia Keys', 2001], [`If I Ain\'t Got You`, 'Alicia Keys', 2003],
  ['No One', 'Alicia Keys', 2007], ['Girl on Fire', 'Alicia Keys', 2012],
  ['Empire State of Mind', 'Alicia Keys', 2009], ['Superwoman', 'Alicia Keys', 2007],

  // Amy Winehouse
  ['Rehab', 'Amy Winehouse', 2006], ['Back to Black', 'Amy Winehouse', 2006],
  ['Valerie', 'Amy Winehouse', 2006], ['Tears Dry on Their Own', 'Amy Winehouse', 2007],
  [`You Know I\'m No Good`, 'Amy Winehouse', 2006],

  // Aretha Franklin
  ['Respect', 'Aretha Franklin', 1967], ['Think', 'Aretha Franklin', 1968],
  ['(You Make Me Feel Like) A Natural Woman', 'Aretha Franklin', 1967],
  ['Chain of Fools', 'Aretha Franklin', 1967], ['I Say a Little Prayer', 'Aretha Franklin', 1968],
  ['Something He Can Feel', 'Aretha Franklin', 1976], ['Rock Steady', 'Aretha Franklin', 1971],
  ['Freeway of Love', 'Aretha Franklin', 1985], ['Who\'s Zoomin\' Who', 'Aretha Franklin', 1985],

  // Avicii
  ['Wake Me Up', 'Avicii', 2013], ['Hey Brother', 'Avicii', 2013],
  ['Levels', 'Avicii', 2011], ['Waiting for Love', 'Avicii', 2015],
  ['The Nights', 'Avicii', 2014], ['Without You', 'Avicii', 2013],

  // Backstreet Boys
  ['I Want It That Way', 'Backstreet Boys', 1999], ['Everybody', 'Backstreet Boys', 1997],
  ['As Long as You Love Me', 'Backstreet Boys', 1997], ['Quit Playing Games', 'Backstreet Boys', 1996],
  ['Show Me the Meaning of Being Lonely', 'Backstreet Boys', 1999],
  ['Larger Than Life', 'Backstreet Boys', 1999],

  // Beatles
  ['Hey Jude', 'Beatles', 1968], ['Let It Be', 'Beatles', 1970],
  ['Come Together', 'Beatles', 1969], ['Yesterday', 'Beatles', 1965],
  [`A Hard Day\'s Night`, 'Beatles', 1964], ['Help!', 'Beatles', 1965],
  ['Twist and Shout', 'Beatles', 1963], ['Love Me Do', 'Beatles', 1962],
  ['Eleanor Rigby', 'Beatles', 1966], ['Blackbird', 'Beatles', 1968],
  ['In My Life', 'Beatles', 1965], ['Something', 'Beatles', 1969],
  ['Here Comes the Sun', 'Beatles', 1969], ['Ob-La-Di Ob-La-Da', 'Beatles', 1968],

  // Bon Jovi
  [`Livin\' on a Prayer`, 'Bon Jovi', 1986], ['You Give Love a Bad Name', 'Bon Jovi', 1986],
  ['Wanted Dead or Alive', 'Bon Jovi', 1986], ['Bad Medicine', 'Bon Jovi', 1988],
  ['Always', 'Bon Jovi', 1994], [`It\'s My Life`, 'Bon Jovi', 2000],
  ['Have a Nice Day', 'Bon Jovi', 2005],

  // Britney Spears
  ['Baby One More Time', 'Britney Spears', 1998], ['Toxic', 'Britney Spears', 2003],
  ['Oops! I Did It Again', 'Britney Spears', 2000], ['Womanizer', 'Britney Spears', 2008],
  ['Gimme More', 'Britney Spears', 2007], ['Lucky', 'Britney Spears', 2000],
  ['Slave 4 U', 'Britney Spears', 2001],

  // Bruce Springsteen
  ['Born to Run', 'Bruce Springsteen', 1975], ['Born in the U.S.A.', 'Bruce Springsteen', 1984],
  ['Dancing in the Dark', 'Bruce Springsteen', 1984], ['The River', 'Bruce Springsteen', 1980],
  ['Thunder Road', 'Bruce Springsteen', 1975], ['Glory Days', 'Bruce Springsteen', 1984],

  // Calvin Harris
  ['Summer', 'Calvin Harris', 2014], ['Feel So Close', 'Calvin Harris', 2011],
  ['We Found Love', 'Calvin Harris', 2011], ['This Is What You Came For', 'Calvin Harris', 2016],
  ['One Kiss', 'Calvin Harris', 2018], ['Promises', 'Calvin Harris', 2018],
  ['How Deep Is Your Love', 'Calvin Harris', 2015],

  // Coolio
  [`Gangsta\'s Paradise`, 'Coolio', 1995], ['Fantastic Voyage', 'Coolio', 1994],
  [`1 2 3 4 (Sumpin\' New)`, 'Coolio', 1996], ['C U When U Get There', 'Coolio', 1997],

  // Daft Punk
  ['Get Lucky', 'Daft Punk', 2013], ['One More Time', 'Daft Punk', 2000],
  ['Around the World', 'Daft Punk', 1997], ['Harder Better Faster Stronger', 'Daft Punk', 2001],
  ['Da Funk', 'Daft Punk', 1995], ['Instant Crush', 'Daft Punk', 2013],
  ['Lose Yourself to Dance', 'Daft Punk', 2013], ['Digital Love', 'Daft Punk', 2001],

  // David Bowie
  ['Heroes', 'David Bowie', 1977], ['Space Oddity', 'David Bowie', 1969],
  ['Ziggy Stardust', 'David Bowie', 1972], [`Let\'s Dance`, 'David Bowie', 1983],
  ['Rebel Rebel', 'David Bowie', 1974], ['Golden Years', 'David Bowie', 1975],
  ['Fame', 'David Bowie', 1975], ['Life on Mars?', 'David Bowie', 1971],
  ['Changes', 'David Bowie', 1971], ['Under Pressure', 'David Bowie', 1981],

  // David Guetta
  ['Titanium', 'David Guetta', 2011], ['Without You', 'David Guetta', 2011],
  ['She Wolf', 'David Guetta', 2009], ['Sexy Bitch', 'David Guetta', 2009],
  ['Dangerous', 'David Guetta', 2014], ['Hey Mama', 'David Guetta', 2015],

  // DMX
  ['Party Up', 'DMX', 1999], [`X Gon\' Give It to Ya`, 'DMX', 2003],
  ['Ruff Ryders Anthem', 'DMX', 1998], [`Slippin\'`, 'DMX', 1998],

  // Dr. Dre
  ['Still D.R.E.', 'Dr. Dre', 1999], ['The Next Episode', 'Dr. Dre', 1999],
  ['Forgot About Dre', 'Dr. Dre', 1999], [`Nuthin\' But a G Thang`, 'Dr. Dre', 1992],
  ['Let Me Ride', 'Dr. Dre', 1992], ['Xxplosive', 'Dr. Dre', 1999],

  // Eagles
  ['Hotel California', 'Eagles', 1976], ['Take It Easy', 'Eagles', 1972],
  ['Desperado', 'Eagles', 1973], ['Life in the Fast Lane', 'Eagles', 1977],
  [`Lyin\' Eyes`, 'Eagles', 1975], ['One of These Nights', 'Eagles', 1975],
  ['Peaceful Easy Feeling', 'Eagles', 1972], ['Best of My Love', 'Eagles', 1974],

  // Fleetwood Mac
  ['Dreams', 'Fleetwood Mac', 1977], ['Go Your Own Way', 'Fleetwood Mac', 1977],
  ['The Chain', 'Fleetwood Mac', 1977], ['Sara', 'Fleetwood Mac', 1979],
  ['Say You Love Me', 'Fleetwood Mac', 1975], ['Gold Dust Woman', 'Fleetwood Mac', 1977],
  ['Oh Well', 'Fleetwood Mac', 1969], ['Never Going Back Again', 'Fleetwood Mac', 1977],

  // Foo Fighters
  ['Everlong', 'Foo Fighters', 1997], ['Best of You', 'Foo Fighters', 2005],
  ['The Pretender', 'Foo Fighters', 2007], ['Learn to Fly', 'Foo Fighters', 1999],
  ['All My Life', 'Foo Fighters', 2002], ['Times Like These', 'Foo Fighters', 2002],
  ['Monkey Wrench', 'Foo Fighters', 1997],

  // Green Day
  ['Basket Case', 'Green Day', 1994], ['Wake Me Up When September Ends', 'Green Day', 2005],
  ['Boulevard of Broken Dreams', 'Green Day', 2004], ['Good Riddance', 'Green Day', 1997],
  ['American Idiot', 'Green Day', 2004], ['Minority', 'Green Day', 2000],
  ['Brain Stew', 'Green Day', 1996], ['Holiday', 'Green Day', 2004],

  // James Brown
  ['I Got You', 'James Brown', 1965], ['Sex Machine', 'James Brown', 1970],
  [`Papa\'s Got a Brand New Bag`, 'James Brown', 1965],
  ['Please Please Please', 'James Brown', 1956], ['Super Bad', 'James Brown', 1970],
  ['Living in America', 'James Brown', 1985],

  // Jay-Z
  ['Empire State of Mind', 'Jay-Z', 2009], ['99 Problems', 'Jay-Z', 2003],
  ['Crazy in Love', 'Jay-Z', 2003], ['Run This Town', 'Jay-Z', 2009],
  ['Izzo (H.O.V.A.)', 'Jay-Z', 2001], ['Hard Knock Life', 'Jay-Z', 1998],

  // Jimi Hendrix
  ['Purple Haze', 'Jimi Hendrix', 1967], ['All Along the Watchtower', 'Jimi Hendrix', 1968],
  ['Hey Joe', 'Jimi Hendrix', 1966], ['Foxy Lady', 'Jimi Hendrix', 1967],
  ['Little Wing', 'Jimi Hendrix', 1967], ['Voodoo Child', 'Jimi Hendrix', 1968],

  // Justin Timberlake
  ['Cry Me a River', 'Justin Timberlake', 2002], ['SexyBack', 'Justin Timberlake', 2006],
  ['What Goes Around', 'Justin Timberlake', 2006], ['Mirrors', 'Justin Timberlake', 2013],
  [`Can\'t Stop the Feeling!`, 'Justin Timberlake', 2016],
  ['Rock Your Body', 'Justin Timberlake', 2003], ['My Love', 'Justin Timberlake', 2006],

  // Kanye West
  ['Gold Digger', 'Kanye West', 2005], ['Stronger', 'Kanye West', 2007],
  ['Heartless', 'Kanye West', 2008], ['Slow Jamz', 'Kanye West', 2003],
  ['All Falls Down', 'Kanye West', 2004], ['Good Life', 'Kanye West', 2007],
  ['Power', 'Kanye West', 2010],

  // Kendrick Lamar
  ['HUMBLE.', 'Kendrick Lamar', 2017], ['Swimming Pools', 'Kendrick Lamar', 2012],
  [`Bitch Don\'t Kill My Vibe`, 'Kendrick Lamar', 2012],
  ['King Kunta', 'Kendrick Lamar', 2015], ['DNA.', 'Kendrick Lamar', 2017],
  ['Alright', 'Kendrick Lamar', 2015], ['Money Trees', 'Kendrick Lamar', 2012],

  // Kenny Rogers
  ['The Gambler', 'Kenny Rogers', 1978], ['Islands in the Stream', 'Kenny Rogers', 1983],
  ['Lucille', 'Kenny Rogers', 1977], ['Lady', 'Kenny Rogers', 1980],
  ['Coward of the County', 'Kenny Rogers', 1979],

  // Led Zeppelin
  ['Stairway to Heaven', 'Led Zeppelin', 1971], ['Whole Lotta Love', 'Led Zeppelin', 1969],
  ['Kashmir', 'Led Zeppelin', 1975], ['Black Dog', 'Led Zeppelin', 1971],
  ['Rock and Roll', 'Led Zeppelin', 1971], ['Immigrant Song', 'Led Zeppelin', 1970],
  ['Communication Breakdown', 'Led Zeppelin', 1969],

  // Lil Nas X
  ['Old Town Road', 'Lil Nas X', 2019], ['MONTERO', 'Lil Nas X', 2021],
  ['Industry Baby', 'Lil Nas X', 2021], [`STAR WALKIN\'`, 'Lil Nas X', 2022],
  [`That\'s What I Want`, 'Lil Nas X', 2021],

  // Luke Bryan
  ['Country Girl', 'Luke Bryan', 2011], [`That\'s My Kind of Night`, 'Luke Bryan', 2013],
  ['Play It Again', 'Luke Bryan', 2014], ['Drink a Beer', 'Luke Bryan', 2013],
  ['Crash My Party', 'Luke Bryan', 2013], ['Light It Up', 'Luke Bryan', 2014],

  // Madonna
  ['Like a Prayer', 'Madonna', 1989], ['Material Girl', 'Madonna', 1984],
  ['Like a Virgin', 'Madonna', 1984], [`Papa Don\'t Preach`, 'Madonna', 1986],
  ['Vogue', 'Madonna', 1990], ['Frozen', 'Madonna', 1998],
  ['Ray of Light', 'Madonna', 1998], ['Hung Up', 'Madonna', 2005],
  ['Holiday', 'Madonna', 1983], ['True Blue', 'Madonna', 1986],

  // Marvin Gaye
  ['Sexual Healing', 'Marvin Gaye', 1982], [`Let\'s Get It On`, 'Marvin Gaye', 1973],
  [`What\'s Going On`, 'Marvin Gaye', 1971], ['Heard It Through the Grapevine', 'Marvin Gaye', 1968],
  ['Mercy Mercy Me', 'Marvin Gaye', 1971], ['Got to Give It Up', 'Marvin Gaye', 1977],
  ['I Heard It Through the Grapevine', 'Marvin Gaye', 1968],

  // Missy Elliott
  ['Work It', 'Missy Elliott', 2002], ['Get Ur Freak On', 'Missy Elliott', 2001],
  ['Lose Control', 'Missy Elliott', 2005], ['Pass That Dutch', 'Missy Elliott', 2003],
  ['Gossip Folks', 'Missy Elliott', 2002],

  // Morgan Wallen
  ['Wasted on You', 'Morgan Wallen', 2020], ['Sand in My Boots', 'Morgan Wallen', 2020],
  ['More Than My Hometown', 'Morgan Wallen', 2020], ['Whiskey Glasses', 'Morgan Wallen', 2018],
  ['7 Summers', 'Morgan Wallen', 2020], ['Thought You Should Know', 'Morgan Wallen', 2023],

  // NSYNC
  ['Bye Bye Bye', 'NSYNC', 2000], ['I Want You Back', 'NSYNC', 1996],
  ['Tearing Up My Heart', 'NSYNC', 1997], [`It\'s Gonna Be Me`, 'NSYNC', 2000],
  ['God Must Have Spent', 'NSYNC', 1998], [`Tearin\' Up My Heart`, 'NSYNC', 1997],

  // Nas
  ['N.Y. State of Mind', 'Nas', 1994], ['If I Ruled the World', 'Nas', 1996],
  ['One Love', 'Nas', 1994], ['The World Is Yours', 'Nas', 1994],
  ['Street Dreams', 'Nas', 1996], ['I Can', 'Nas', 2002],

  // Nirvana
  ['Smells Like Teen Spirit', 'Nirvana', 1991], ['Come as You Are', 'Nirvana', 1992],
  ['Heart-Shaped Box', 'Nirvana', 1993], ['Lithium', 'Nirvana', 1991],
  ['In Bloom', 'Nirvana', 1991], ['Rape Me', 'Nirvana', 1993],
  ['About a Girl', 'Nirvana', 1989], ['The Man Who Sold the World', 'Nirvana', 1993],

  // Notorious B.I.G.
  ['Hypnotize', 'Notorious B.I.G', 1997], ['Big Poppa', 'Notorious B.I.G', 1994],
  ['Juicy', 'Notorious B.I.G', 1994], ['Mo Money Mo Problems', 'Notorious B.I.G', 1997],
  ['One More Chance', 'Notorious B.I.G', 1995],

  // Oasis
  ['Wonderwall', 'Oasis', 1995], [`Don\'t Look Back in Anger`, 'Oasis', 1996],
  ['Champagne Supernova', 'Oasis', 1995], ['Live Forever', 'Oasis', 1994],
  ['Some Might Say', 'Oasis', 1995], ['Stand by Me', 'Oasis', 1997],
  ['Half the World Away', 'Oasis', 1994],

  // Otis Redding
  [`(Sittin\' On) The Dock of the Bay`, 'Otis Redding', 1967],
  ['Try a Little Tenderness', 'Otis Redding', 1966],
  ['Respect', 'Otis Redding', 1965], [`I\'ve Been Loving You Too Long`, 'Otis Redding', 1965],

  // Pearl Jam
  ['Alive', 'Pearl Jam', 1991], ['Even Flow', 'Pearl Jam', 1992],
  ['Jeremy', 'Pearl Jam', 1992], ['Black', 'Pearl Jam', 1991],
  ['Better Man', 'Pearl Jam', 1994], ['Last Kiss', 'Pearl Jam', 1999],
  ['Given to Fly', 'Pearl Jam', 1998],

  // Pink Floyd
  ['Another Brick in the Wall', 'Pink Floyd', 1979],
  ['Wish You Were Here', 'Pink Floyd', 1975], ['Comfortably Numb', 'Pink Floyd', 1979],
  ['Money', 'Pink Floyd', 1973], ['Time', 'Pink Floyd', 1973],
  ['Shine On You Crazy Diamond', 'Pink Floyd', 1975],
  ['Learning to Fly', 'Pink Floyd', 1987], ['Hey You', 'Pink Floyd', 1979],

  // Post Malone
  ['Rockstar', 'Post Malone', 2017], ['Sunflower', 'Post Malone', 2018],
  ['Better Now', 'Post Malone', 2018], ['Circles', 'Post Malone', 2019],
  ['Congratulations', 'Post Malone', 2016], ['White Iverson', 'Post Malone', 2015],
  ['Psycho', 'Post Malone', 2018], ['I Fall Apart', 'Post Malone', 2016],

  // Rolling Stones
  ['Paint It Black', 'Rolling Stones', 1966], ['Sympathy for the Devil', 'Rolling Stones', 1968],
  ['Gimme Shelter', 'Rolling Stones', 1969], ['Start Me Up', 'Rolling Stones', 1981],
  [`(I Can\'t Get No) Satisfaction`, 'Rolling Stones', 1965],
  [`Jumpin\' Jack Flash`, 'Rolling Stones', 1968], ['Angie', 'Rolling Stones', 1973],
  ['Wild Horses', 'Rolling Stones', 1971], ['Miss You', 'Rolling Stones', 1978],

  // SZA
  ['Good Days', 'SZA', 2020], ['Kill Bill', 'SZA', 2022],
  ['Shirt', 'SZA', 2022], ['Snooze', 'SZA', 2022],
  ['Love Galore', 'SZA', 2017], ['The Weekend', 'SZA', 2017],
  ['Drew Barrymore', 'SZA', 2017], ['Broken Clocks', 'SZA', 2017],

  // Snoop Dogg
  ['Gin and Juice', 'Snoop Dogg', 1994], [`Drop It Like It\'s Hot`, 'Snoop Dogg', 2004],
  ['Beautiful', 'Snoop Dogg', 2003], ['Signs', 'Snoop Dogg', 2005],
  ['Doggy Dogg World', 'Snoop Dogg', 1993], ['Who Am I?', 'Snoop Dogg', 1993],

  // Spice Girls
  ['Wannabe', 'Spice Girls', 1996], [`Say You\'ll Be There`, 'Spice Girls', 1996],
  ['2 Become 1', 'Spice Girls', 1996], ['Mama', 'Spice Girls', 1997],
  ['Who Do You Think You Are', 'Spice Girls', 1997], ['Stop', 'Spice Girls', 1997],
  ['Too Much', 'Spice Girls', 1997],

  // Stevie Wonder
  ['Superstition', 'Stevie Wonder', 1972], ['I Just Called to Say I Love You', 'Stevie Wonder', 1984],
  ['Sir Duke', 'Stevie Wonder', 1977], ['Happy Birthday', 'Stevie Wonder', 1980],
  [`Isn\'t She Lovely`, 'Stevie Wonder', 1976], ['Higher Ground', 'Stevie Wonder', 1973],
  ['Signed Sealed Delivered', 'Stevie Wonder', 1970], ['Master Blaster', 'Stevie Wonder', 1980],

  // TLC
  ['Waterfalls', 'TLC', 1995], ['No Scrubs', 'TLC', 1999],
  ['Creep', 'TLC', 1994], ['Crazy Sexy Cool', 'TLC', 1994],
  ['Red Light Special', 'TLC', 1994], ['Unpretty', 'TLC', 1999],

  // 2Pac
  ['California Love', '2Pac', 1995], ['Dear Mama', '2Pac', 1995],
  ['All Eyez on Me', '2Pac', 1996], ['Changes', '2Pac', 1998],
  ['Gangsta Paradise', '2Pac', 1995], [`Hit \'Em Up`, '2Pac', 1996],
  ['How Do U Want It', '2Pac', 1996], ['Keep Ya Head Up', '2Pac', 1993],

  // U2
  ['With or Without You', 'U2', 1987], ['One', 'U2', 1992],
  ['Sunday Bloody Sunday', 'U2', 1983], ['Where the Streets Have No Name', 'U2', 1987],
  ['I Still Haven\'t Found What I\'m Looking For', 'U2', 1987],
  ['Beautiful Day', 'U2', 2000], ['Mysterious Ways', 'U2', 1991],
  ['Elevation', 'U2', 2001], ['Vertigo', 'U2', 2004],

  // Usher
  ['Yeah!', 'Usher', 2004], ['Confessions Part II', 'Usher', 2004],
  ['My Boo', 'Usher', 2004], ['Burn', 'Usher', 2004],
  ['Love in This Club', 'Usher', 2008], ['OMG', 'Usher', 2010],
  [`DJ Got Us Fallin\' in Love`, 'Usher', 2010], ['U Got It Bad', 'Usher', 2001],

  // Van Halen
  ['Jump', 'Van Halen', 1984], ['Panama', 'Van Halen', 1984],
  ['Hot for Teacher', 'Van Halen', 1984], [`Runnin\' with the Devil`, 'Van Halen', 1978],
  ['Eruption', 'Van Halen', 1978], [`Why Can\'t This Be Love`, 'Van Halen', 1986],

  // Warren G
  ['Regulate', 'Warren G', 1994], ['This DJ', 'Warren G', 1994],
  [`What\'s Next`, 'Warren G', 1994], ['I Want It All', 'Warren G', 1999],

  // Additional songs for major artists — more Deezer publisher coverage

  // Dua Lipa extras
  ['Future Nostalgia', 'Dua Lipa', 2020], ['Hallucinate', 'Dua Lipa', 2020],
  ['Cool', 'Dua Lipa', 2020], ['Pretty Please', 'Dua Lipa', 2020],
  ['Boys Will Be Boys', 'Dua Lipa', 2020], ['Love Again', 'Dua Lipa', 2020],
  ['Prisoner', 'Dua Lipa', 2020], ['Electricity', 'Dua Lipa', 2018],
  ['Genesis', 'Dua Lipa', 2017], ['Lost in Your Light', 'Dua Lipa', 2017],
  [`Thinking 'Bout You`, 'Dua Lipa', 2017], ['Garden', 'Dua Lipa', 2017],

  // Taylor Swift extras
  ['Speak Now', 'Taylor Swift', 2010], ['Back to December', 'Taylor Swift', 2010],
  ['Mean', 'Taylor Swift', 2011], ['Long Live', 'Taylor Swift', 2010],
  ['Begin Again', 'Taylor Swift', 2012], ['Red', 'Taylor Swift', 2012],
  ['Holy Ground', 'Taylor Swift', 2012], ['Treacherous', 'Taylor Swift', 2012],
  ['Out of the Woods', 'Taylor Swift', 2014], ['Clean', 'Taylor Swift', 2014],
  ['Getaway Car', 'Taylor Swift', 2017], ['Look What You Made Me Do', 'Taylor Swift', 2017],
  [`Don't Blame Me`, 'Taylor Swift', 2017], ['Delicate', 'Taylor Swift', 2018],
  ['Cornelia Street', 'Taylor Swift', 2019], ['London Boy', 'Taylor Swift', 2019],
  ['Exile', 'Taylor Swift', 2020], ['august', 'Taylor Swift', 2020],
  ['Betty', 'Taylor Swift', 2020], ['illicit affairs', 'Taylor Swift', 2020],
  ['this is me trying', 'Taylor Swift', 2020], ['tolerate it', 'Taylor Swift', 2020],
  ['Mastermind', 'Taylor Swift', 2022], ['Snow on the Beach', 'Taylor Swift', 2022],
  ['Question...?', 'Taylor Swift', 2022], [`You're on Your Own Kid`, 'Taylor Swift', 2022],
  ['Marjorie', 'Taylor Swift', 2020], ['right where you left me', 'Taylor Swift', 2020],

  // Ed Sheeran extras
  ['Lego House', 'Ed Sheeran', 2011], ['Drunk', 'Ed Sheeran', 2011],
  ['Small Bump', 'Ed Sheeran', 2012], ['Give Me Love', 'Ed Sheeran', 2012],
  ['Bloodstream', 'Ed Sheeran', 2015], ['Thinking Out Loud', 'Ed Sheeran', 2014],
  [`Don't`, 'Ed Sheeran', 2014], ['Nina', 'Ed Sheeran', 2014],
  ['Tenerife Sea', 'Ed Sheeran', 2014], [`Hearts Don't Break Around Here`, 'Ed Sheeran', 2017],
  ['What Do I Know?', 'Ed Sheeran', 2017], ['New Man', 'Ed Sheeran', 2017],
  ['Happier', 'Ed Sheeran', 2017], ['Perfect Duet', 'Ed Sheeran', 2017],
  ['Remember the Name', 'Ed Sheeran', 2019], ['Cross Me', 'Ed Sheeran', 2019],
  ['Put It All on Me', 'Ed Sheeran', 2019], ['Best Part of Me', 'Ed Sheeran', 2019],
  ['Antisocial', 'Ed Sheeran', 2019], ['2step', 'Ed Sheeran', 2021],
  ['Peru', 'Ed Sheeran', 2021], ['Visiting Hours', 'Ed Sheeran', 2021],
  ['Celestial', 'Ed Sheeran', 2022], ['Eyes Closed', 'Ed Sheeran', 2023],

  // Eminem extras
  ['The Way I Am', 'Eminem', 2000], ['Kim', 'Eminem', 2000],
  ['Marshall Mathers', 'Eminem', 2000], ['Criminal', 'Eminem', 2000],
  ['Business', 'Eminem', 2002], [`Cleanin' Out My Closet`, 'Eminem', 2002],
  [`When I'm Gone`, 'Eminem', 2005], ['Like Toy Soldiers', 'Eminem', 2004],
  ['Mosh', 'Eminem', 2004], ['Mockingbird', 'Eminem', 2004],
  [`Hailie's Song`, 'Eminem', 2002], [`When I'm Gone`, 'Eminem', 2005],
  ['Beautiful', 'Eminem', 2009], ['Crack a Bottle', 'Eminem', 2009],
  ['3 a.m.', 'Eminem', 2009], ['Medicine Ball', 'Eminem', 2009],
  ['No Love', 'Eminem', 2010], ['Space Bound', 'Eminem', 2011],
  ['The Monster', 'Eminem', 2013], ['Berzerk', 'Eminem', 2013],
  ['Survival', 'Eminem', 2013], ['Guts Over Fear', 'Eminem', 2014],
  ['Walk on Water', 'Eminem', 2017], ['River', 'Eminem', 2017],

  // Justin Bieber extras
  ['One Less Lonely Girl', 'Justin Bieber', 2009], ['Somebody to Love', 'Justin Bieber', 2010],
  ['Boyfriend', 'Justin Bieber', 2012], ['Beauty and a Beat', 'Justin Bieber', 2012],
  ['As Long as You Love Me', 'Justin Bieber', 2012], ['Right Here', 'Justin Bieber', 2012],
  ['Confident', 'Justin Bieber', 2013], ['Hold Tight', 'Justin Bieber', 2013],
  ['Where Are U Now', 'Justin Bieber', 2015], ['Company', 'Justin Bieber', 2016],
  ['Cold Water', 'Justin Bieber', 2016], ['Friends', 'Justin Bieber', 2017],
  ['Let Me Love You', 'Justin Bieber', 2016], ['Life Is Worth Living', 'Justin Bieber', 2015],
  ['Love Yourself', 'Justin Bieber', 2015], ['Holy', 'Justin Bieber', 2020],
  ['Lonely', 'Justin Bieber', 2020], ['Anyone', 'Justin Bieber', 2021],
  ['Deserve You', 'Justin Bieber', 2021], ['Die in Your Arms', 'Justin Bieber', 2022],

  // Queen extras
  ['Crazy Little Thing Called Love', 'Queen', 1979],
  ['A Kind of Magic', 'Queen', 1986], ['Innuendo', 'Queen', 1991],
  ['The Show Must Go On', 'Queen', 1991], ['These Are the Days of Our Lives', 'Queen', 1991],
  ['One Vision', 'Queen', 1985], ['Breakthru', 'Queen', 1989],
  ['The Invisible Man', 'Queen', 1989], ['Headlong', 'Queen', 1991],
  ['Flash', 'Queen', 1980], ['Save Me', 'Queen', 1980],
  ['Play the Game', 'Queen', 1980], ['Spread Your Wings', 'Queen', 1978],
  ['Good Old-Fashioned Lover Boy', 'Queen', 1977], ['Tie Your Mother Down', 'Queen', 1977],

  // Shania Twain extras
  ['Love Gets Me Every Time', 'Shania Twain', 1997],
  ['Black Eyes Blue Tears', 'Shania Twain', 1998],
  ['When You Kiss Me', 'Shania Twain', 2002],
  ['In My Car', 'Shania Twain', 2002], [`She's Not Just a Pretty Face`, 'Shania Twain', 2002],
  ['Up!', 'Shania Twain', 2002], [`I'm Gonna Getcha Good!`, 'Shania Twain', 2002],
  ['Thank You Baby', 'Shania Twain', 2003], ['Forever and for Always', 'Shania Twain', 2002],
  [`Don't Be Stupid`, 'Shania Twain', 1995], [`If You're Not the One`, 'Shania Twain', 1995],
  ['The Woman in Me', 'Shania Twain', 1995], ['Leaving Is the Only Way Out', 'Shania Twain', 1995],
  [`Home Ain't Where His Heart Is`, 'Shania Twain', 1993],
  ['Dance with the One That Brought You', 'Shania Twain', 1993],


];

// Build lookup map: normalised "title||artist" → year
const KNOWN_YEAR_MAP = new Map();
for (const [title, artist, year] of KNOWN_YEARS) {
  const key = title.toLowerCase().trim() + '||' + artist.toLowerCase().trim();
  KNOWN_YEAR_MAP.set(key, year);
}

function knownYear(title, artist) {
  const key = title.toLowerCase().trim() + '||' + artist.toLowerCase().trim();
  return KNOWN_YEAR_MAP.get(key) || null;
}

// ─── Deezer original song cross-reference ────────────────────────────────────
// When a song is not in KNOWN_YEARS, we search Deezer for the ORIGINAL
// recording (no karaoke keywords) and read the album release_date from there.
// This is the same API we already use — fast, no extra rate limits, no
// external services.
//
// e.g. artist:"Adele" track:"Hello" → returns the original 25 album entry
// with release_date "2015-11-20" → year 2015 ✓
//
// The karaoke track's album.release_date is always wrong (it's the karaoke
// publisher's upload date). The original song search is accurate.
const deezerYearCache = new Map();

async function lookupOriginalYear(title, artist) {
  const key = title.toLowerCase() + '||' + artist.toLowerCase();
  if (deezerYearCache.has(key)) return deezerYearCache.get(key);

  // Small delay to avoid hammering Deezer (we already delay in deezerFetch)
  await new Promise(r => setTimeout(r, 100));

  try {
    // Search for the original song — no karaoke/instrumental keywords
    // Use Deezer's field-specific search: artist: and track: operators
    const q = 'artist:"' + artist.replace(/"/g, '') + '" track:"' + title.replace(/"/g, '') + '"';
    const url = 'https://api.deezer.com/search?q=' + encodeURIComponent(q) + '&limit=10';

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { deezerYearCache.set(key, null); return null; }

    const data = await res.json();
    const tracks = data.data || [];

    // Find the earliest album release date across results
    // Filter out obvious karaoke results and pick the earliest real release
    let bestYear = null;
    for (const t of tracks) {
      // Skip karaoke/instrumental results that snuck through
      const titleLower = (t.title || '').toLowerCase();
      if (INSTRUMENTAL_KEYWORDS.some(kw => titleLower.includes(kw))) continue;

      const dateStr = t.album && t.album.release_date ? t.album.release_date : '';
      const year    = parseInt(dateStr.slice(0, 4));
      if (!isNaN(year) && year >= 1920 && year <= 2030) {
        if (bestYear === null || year < bestYear) bestYear = year;
      }
    }

    deezerYearCache.set(key, bestYear);
    return bestYear;
  } catch (err) {
    console.warn('  Deezer year lookup failed [' + title + ']:', err.message);
    deezerYearCache.set(key, null);
    return null;
  }
}

// ─── Deezer fetch ─────────────────────────────────────────────────────────────
async function deezerFetch(url) {
  await new Promise(r => setTimeout(r, 200));
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Deezer HTTP ' + res.status);
  return res.json();
}

async function fetchInstrumentalTracks(query) {
  const url  = 'https://api.deezer.com/search?q=' + encodeURIComponent(query) + '&limit=100';
  const data = await deezerFetch(url);
  return (data.data || []).filter(t =>
    t.preview && isInstrumental(t) && hasSensibleDuration(t) && !isRejectedTitle(t.title || '')
  );
}

// ─── Insert ───────────────────────────────────────────────────────────────────
async function insertTracks(tracks, source) {
  if (!tracks.length) return { inserted: 0, rejected: 0 };
  let inserted = 0, rejected = 0;

  for (const track of tracks) {
    // 1. Extract real song title
    const title = extractRealTitle(track);
    if (!title || title.length < 2) { rejected++; continue; }
    const lowerTitle = title.toLowerCase().trim();
    if (['karaoke version','instrumental','backing track','karaoke',
         'karaoke version of the original','instrumental version'].includes(lowerTitle)) {
      rejected++; continue;
    }
    if (isRejectedTitle(title)) { rejected++; continue; }

    // 2. Determine the real artist
    //    Priority: extracted from title > artist_lock fallback
    //    For artist_lock sources, the lock IS the artist — no title parsing needed.
    let realArtist = extractOriginalArtist(track);
    if (!realArtist) {
      if (source.artist_lock) {
        realArtist = source.artist_lock; // use the locked artist directly
      } else {
        rejected++; continue; // no artist and no lock — skip
      }
    }

    // 3. artist_lock strict enforcement
    if (source.artist_lock) {
      const lockNorm   = normArtist(source.artist_lock);
      const artistNorm = normArtist(realArtist);
      const exactMatch  = artistNorm === lockNorm;
      const startsMatch = artistNorm.startsWith(lockNorm + ' ') ||
                          artistNorm.startsWith(lockNorm + '&') ||
                          artistNorm.startsWith(lockNorm + ',');
      if (!exactMatch && !startsMatch) { rejected++; continue; }
    }

    const cleanArtist = realArtist.split(/[,&]/)[0].trim();

    // 4. Get original release year
    //    Step A: check KNOWN_YEARS table (instant — 768 hand-curated songs)
    //    Step B: Deezer cross-reference — search for the original song recording
    //            to get the real album release_date (not the karaoke upload date).
    //            Fast (~100ms), same API, in-memory cached per ingest run.
    let originalYear = knownYear(title, cleanArtist);
    if (originalYear === null) {
      originalYear = await lookupOriginalYear(title, cleanArtist);
    }

    // 5. Validate year against source's decade window
    //    Known-year and MB-found years are validated strictly.
    //    If year is completely unknown (null) — insert with null decade, no penalty.
    if (originalYear !== null) {
      if (originalYear < source.decade_min || originalYear > source.decade_max) {
        rejected++; continue;
      }
    }

    const era          = source.era;
    const genre        = source.genre;
    const decade       = originalYear;
    const deezerQuery  = '"' + title + '" "' + cleanArtist + '" instrumental karaoke';

    try {
      const result = await pool.query(
        'INSERT INTO songs (title, artist, era, genre, decade, deezer_query) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'ON CONFLICT (lower(title), lower(artist)) DO NOTHING',
        [title, realArtist, era, genre, decade, deezerQuery]
      );
      if (result.rowCount > 0) inserted++;
    } catch (err) {
      console.warn('  Insert error [' + title + ']:', err.message);
    }
  }
  return { inserted, rejected };
}

// ─── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  // POP
  { query: 'Karaoke Hits pop 2010s',            genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Pop 2010s'  },
  { query: 'Karaoke Hits pop 2020s',            genre:'pop', era:'modern', decade_min:2020, decade_max:2029, label:'Pop 2020s'  },
  { query: 'Karaoke Hits pop 2000s',            genre:'pop', era:'2000s',  decade_min:2000, decade_max:2009, label:'Pop 2000s'  },
  { query: 'Karaoke Hits pop 90s',              genre:'pop', era:'80s90s', decade_min:1990, decade_max:1999, label:'Pop 90s'    },
  { query: 'Karaoke Hits pop 80s',              genre:'pop', era:'80s90s', decade_min:1980, decade_max:1989, label:'Pop 80s'    },

  { query: 'Taylor Swift karaoke instrumental', genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 1', artist_lock:'Taylor Swift' },
  { query: 'Taylor Swift karaoke',              genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 2', artist_lock:'Taylor Swift' },
  { query: 'Taylor Swift backing track',        genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 3', artist_lock:'Taylor Swift' },
  { query: '"Taylor Swift" instrumental',       genre:'pop', era:'modern', decade_min:2006, decade_max:2029, label:'Taylor Swift 4', artist_lock:'Taylor Swift' },

  { query: 'Adele karaoke instrumental',        genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 1', artist_lock:'Adele' },
  { query: 'Adele karaoke',                     genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 2', artist_lock:'Adele' },
  { query: 'Adele backing track instrumental',  genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 3', artist_lock:'Adele' },
  { query: '"Adele" instrumental',              genre:'pop', era:'modern', decade_min:2008, decade_max:2029, label:'Adele 4', artist_lock:'Adele' },

  { query: 'Ed Sheeran karaoke instrumental',   genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 1', artist_lock:'Ed Sheeran' },
  { query: 'Ed Sheeran karaoke',                genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 2', artist_lock:'Ed Sheeran' },
  { query: 'Ed Sheeran backing track',          genre:'pop', era:'modern', decade_min:2011, decade_max:2029, label:'Ed Sheeran 3', artist_lock:'Ed Sheeran' },

  { query: 'Bruno Mars karaoke instrumental',   genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 1', artist_lock:'Bruno Mars' },
  { query: 'Bruno Mars karaoke',                genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 2', artist_lock:'Bruno Mars' },
  { query: 'Bruno Mars backing track',          genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Bruno Mars 3', artist_lock:'Bruno Mars' },

  { query: 'Billie Eilish karaoke instrumental',genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 1', artist_lock:'Billie Eilish' },
  { query: 'Billie Eilish karaoke',             genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 2', artist_lock:'Billie Eilish' },
  { query: 'Billie Eilish backing track',       genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Billie Eilish 3', artist_lock:'Billie Eilish' },

  { query: 'Olivia Rodrigo karaoke',             genre:'pop', era:'modern', decade_min:2021, decade_max:2029, label:'Olivia Rodrigo 1', artist_lock:'Olivia Rodrigo' },
  { query: 'Olivia Rodrigo karaoke instrumental',genre:'pop', era:'modern', decade_min:2021, decade_max:2029, label:'Olivia Rodrigo 2', artist_lock:'Olivia Rodrigo' },

  { query: 'Dua Lipa karaoke instrumental',     genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 1', artist_lock:'Dua Lipa' },
  { query: 'Dua Lipa karaoke',                  genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 2', artist_lock:'Dua Lipa' },
  { query: 'Dua Lipa backing track',            genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Dua Lipa 3', artist_lock:'Dua Lipa' },

  { query: 'Harry Styles karaoke instrumental', genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Harry Styles 1', artist_lock:'Harry Styles' },
  { query: 'Harry Styles karaoke',              genre:'pop', era:'modern', decade_min:2017, decade_max:2029, label:'Harry Styles 2', artist_lock:'Harry Styles' },

  { query: 'Ariana Grande karaoke instrumental',genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 1', artist_lock:'Ariana Grande' },
  { query: 'Ariana Grande karaoke',             genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 2', artist_lock:'Ariana Grande' },
  { query: 'Ariana Grande backing track',       genre:'pop', era:'modern', decade_min:2013, decade_max:2029, label:'Ariana Grande 3', artist_lock:'Ariana Grande' },

  { query: 'Justin Bieber karaoke instrumental',genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 1', artist_lock:'Justin Bieber' },
  { query: 'Justin Bieber karaoke',             genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 2', artist_lock:'Justin Bieber' },
  { query: 'Justin Bieber backing track',       genre:'pop', era:'modern', decade_min:2010, decade_max:2029, label:'Justin Bieber 3', artist_lock:'Justin Bieber' },

  { query: 'Lady Gaga karaoke instrumental',    genre:'pop', era:'2000s',  decade_min:2008, decade_max:2015, label:'Lady Gaga',        artist_lock:'Lady Gaga'        },
  { query: 'Beyonce karaoke instrumental',      genre:'pop', era:'2000s',  decade_min:2003, decade_max:2016, label:'Beyonce',          artist_lock:'Beyonce'          },
  { query: 'Rihanna karaoke instrumental',      genre:'pop', era:'2000s',  decade_min:2005, decade_max:2016, label:'Rihanna',          artist_lock:'Rihanna'          },
  { query: 'Britney Spears karaoke',            genre:'pop', era:'2000s',  decade_min:1998, decade_max:2011, label:'Britney Spears',   artist_lock:'Britney Spears'   },
  { query: 'Justin Timberlake karaoke',         genre:'pop', era:'2000s',  decade_min:2002, decade_max:2018, label:'Justin Timberlake',artist_lock:'Justin Timberlake'},
  { query: 'Backstreet Boys karaoke',           genre:'pop', era:'80s90s', decade_min:1996, decade_max:2005, label:'Backstreet Boys',  artist_lock:'Backstreet Boys'  },
  { query: 'NSYNC karaoke instrumental',        genre:'pop', era:'80s90s', decade_min:1996, decade_max:2002, label:'NSYNC',            artist_lock:'NSYNC'            },
  { query: 'Spice Girls karaoke',               genre:'pop', era:'80s90s', decade_min:1996, decade_max:2001, label:'Spice Girls',      artist_lock:'Spice Girls'      },
  { query: 'ABBA karaoke instrumental',         genre:'pop', era:'60s70s', decade_min:1972, decade_max:1982, label:'ABBA 1',           artist_lock:'ABBA'             },
  { query: 'ABBA karaoke',                      genre:'pop', era:'60s70s', decade_min:1972, decade_max:1982, label:'ABBA 2',           artist_lock:'ABBA'             },
  { query: 'Elton John karaoke instrumental',   genre:'pop', era:'60s70s', decade_min:1970, decade_max:1990, label:'Elton John 1',     artist_lock:'Elton John'       },
  { query: 'Elton John karaoke',                genre:'pop', era:'60s70s', decade_min:1970, decade_max:1990, label:'Elton John 2',     artist_lock:'Elton John'       },
  { query: 'Madonna karaoke instrumental',      genre:'pop', era:'80s90s', decade_min:1983, decade_max:2000, label:'Madonna',          artist_lock:'Madonna'          },

  // ROCK
  { query: 'Karaoke Hits rock 90s',             genre:'rock', era:'80s90s', decade_min:1990, decade_max:1999, label:'Rock 90s'   },
  { query: 'Karaoke Hits rock 80s',             genre:'rock', era:'80s90s', decade_min:1980, decade_max:1989, label:'Rock 80s'   },
  { query: 'Karaoke Hits rock 2000s',           genre:'rock', era:'2000s',  decade_min:2000, decade_max:2009, label:'Rock 2000s' },
  { query: 'Guns N Roses karaoke',              genre:'rock', era:'80s90s', decade_min:1987, decade_max:1999, label:'GNR',       artist_lock:"Guns N' Roses" },
  { query: 'Bon Jovi karaoke instrumental',     genre:'rock', era:'80s90s', decade_min:1984, decade_max:2000, label:'Bon Jovi',  artist_lock:'Bon Jovi'      },
  { query: 'U2 karaoke instrumental',           genre:'rock', era:'80s90s', decade_min:1980, decade_max:2005, label:'U2',        artist_lock:'U2'            },
  { query: 'Nirvana karaoke instrumental',      genre:'rock', era:'80s90s', decade_min:1989, decade_max:1999, label:'Nirvana',   artist_lock:'Nirvana'       },
  { query: 'Pearl Jam karaoke instrumental',    genre:'rock', era:'80s90s', decade_min:1991, decade_max:2002, label:'Pearl Jam', artist_lock:'Pearl Jam'     },
  { query: 'Oasis karaoke instrumental',        genre:'rock', era:'80s90s', decade_min:1994, decade_max:2009, label:'Oasis',     artist_lock:'Oasis'         },
  { query: 'Green Day karaoke instrumental',    genre:'rock', era:'2000s',  decade_min:1994, decade_max:2012, label:'Green Day', artist_lock:'Green Day'     },
  { query: 'Coldplay karaoke instrumental',     genre:'rock', era:'2000s',  decade_min:2000, decade_max:2015, label:'Coldplay 1',artist_lock:'Coldplay'      },
  { query: 'Coldplay karaoke',                  genre:'rock', era:'2000s',  decade_min:2000, decade_max:2015, label:'Coldplay 2',artist_lock:'Coldplay'      },
  { query: 'Foo Fighters karaoke',              genre:'rock', era:'2000s',  decade_min:1995, decade_max:2015, label:'Foo Fighters',artist_lock:'Foo Fighters'},

  // CLASSIC ROCK
  { query: 'Queen karaoke instrumental',             genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 1',      artist_lock:'Queen'          },
  { query: 'Queen karaoke',                          genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 2',      artist_lock:'Queen'          },
  { query: 'Queen backing track',                    genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1991, label:'Queen 3',      artist_lock:'Queen'          },
  { query: 'Beatles karaoke instrumental',           genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 1',    artist_lock:'Beatles'        },
  { query: 'Beatles karaoke',                        genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 2',    artist_lock:'Beatles'        },
  { query: 'Beatles backing track',                  genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1970, label:'Beatles 3',    artist_lock:'Beatles'        },
  { query: 'Led Zeppelin karaoke instrumental',      genre:'classic-rock', era:'60s70s', decade_min:1968, decade_max:1982, label:'Led Zeppelin', artist_lock:'Led Zeppelin'   },
  { query: 'Rolling Stones karaoke',                 genre:'classic-rock', era:'60s70s', decade_min:1963, decade_max:1982, label:'Stones',       artist_lock:'Rolling Stones' },
  { query: 'Fleetwood Mac karaoke',                  genre:'classic-rock', era:'60s70s', decade_min:1968, decade_max:1990, label:'Fleetwood Mac',artist_lock:'Fleetwood Mac'  },
  { query: 'Eagles karaoke instrumental',            genre:'classic-rock', era:'60s70s', decade_min:1972, decade_max:1982, label:'Eagles',       artist_lock:'Eagles'         },
  { query: 'David Bowie karaoke instrumental',       genre:'classic-rock', era:'60s70s', decade_min:1969, decade_max:1990, label:'Bowie',        artist_lock:'David Bowie'    },
  { query: 'Pink Floyd karaoke instrumental',        genre:'classic-rock', era:'60s70s', decade_min:1967, decade_max:1983, label:'Pink Floyd',   artist_lock:'Pink Floyd'     },
  { query: 'Jimi Hendrix karaoke instrumental',      genre:'classic-rock', era:'60s70s', decade_min:1966, decade_max:1971, label:'Jimi Hendrix', artist_lock:'Jimi Hendrix'   },
  { query: 'Aerosmith karaoke instrumental',         genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1999, label:'Aerosmith',    artist_lock:'Aerosmith'      },
  { query: 'AC/DC karaoke instrumental',             genre:'classic-rock', era:'60s70s', decade_min:1975, decade_max:1995, label:'AC/DC',        artist_lock:'AC/DC'          },
  { query: 'Bruce Springsteen karaoke',              genre:'classic-rock', era:'60s70s', decade_min:1973, decade_max:1995, label:'Springsteen',  artist_lock:'Bruce Springsteen'},
  { query: 'Van Halen karaoke instrumental',         genre:'classic-rock', era:'80s90s', decade_min:1978, decade_max:1995, label:'Van Halen',    artist_lock:'Van Halen'      },

  // HIP-HOP
  { query: 'Eminem karaoke instrumental',       genre:'hip-hop', era:'2000s',  decade_min:1999, decade_max:2013, label:'Eminem',         artist_lock:'Eminem'        },
  { query: 'Drake karaoke instrumental',        genre:'hip-hop', era:'modern', decade_min:2009, decade_max:2029, label:'Drake',          artist_lock:'Drake'         },
  { query: 'Kanye West karaoke instrumental',   genre:'hip-hop', era:'2000s',  decade_min:2004, decade_max:2016, label:'Kanye West',     artist_lock:'Kanye West'    },
  { query: 'Jay Z karaoke instrumental',        genre:'hip-hop', era:'2000s',  decade_min:1996, decade_max:2014, label:'Jay-Z',          artist_lock:'Jay-Z'         },
  { query: 'Kendrick Lamar karaoke',            genre:'hip-hop', era:'modern', decade_min:2011, decade_max:2029, label:'Kendrick Lamar', artist_lock:'Kendrick Lamar'},
  { query: 'Post Malone karaoke',               genre:'hip-hop', era:'modern', decade_min:2016, decade_max:2029, label:'Post Malone',    artist_lock:'Post Malone'   },
  { query: 'Lil Nas X karaoke',                 genre:'hip-hop', era:'modern', decade_min:2018, decade_max:2029, label:'Lil Nas X',      artist_lock:'Lil Nas X'     },

  // 90s RAP
  { query: 'Tupac karaoke instrumental',               genre:'90s-rap', era:'80s90s', decade_min:1991, decade_max:1999, label:'Tupac',     artist_lock:'2Pac'           },
  { query: 'Biggie Smalls karaoke instrumental',       genre:'90s-rap', era:'80s90s', decade_min:1994, decade_max:1999, label:'Biggie',    artist_lock:'Notorious B.I.G'},
  { query: 'Snoop Dogg 90s karaoke instrumental',      genre:'90s-rap', era:'80s90s', decade_min:1993, decade_max:1999, label:'Snoop 90s', artist_lock:'Snoop Dogg'    },
  { query: 'Dr Dre karaoke instrumental 90s',          genre:'90s-rap', era:'80s90s', decade_min:1992, decade_max:1999, label:'Dr Dre',    artist_lock:'Dr. Dre'       },
  { query: 'Nas karaoke instrumental',                 genre:'90s-rap', era:'80s90s', decade_min:1994, decade_max:2001, label:'Nas',       artist_lock:'Nas'           },
  { query: 'DMX karaoke instrumental',                 genre:'90s-rap', era:'80s90s', decade_min:1998, decade_max:2003, label:'DMX',       artist_lock:'DMX'           },
  { query: 'Coolio karaoke instrumental',              genre:'90s-rap', era:'80s90s', decade_min:1994, decade_max:2001, label:'Coolio',    artist_lock:'Coolio'        },
  { query: 'Missy Elliott karaoke',                    genre:'90s-rap', era:'80s90s', decade_min:1997, decade_max:2006, label:'Missy',     artist_lock:'Missy Elliott' },
  { query: 'TLC karaoke instrumental',                 genre:'90s-rap', era:'80s90s', decade_min:1992, decade_max:2002, label:'TLC',       artist_lock:'TLC'           },
  { query: 'Warren G karaoke instrumental',            genre:'90s-rap', era:'80s90s', decade_min:1994, decade_max:2001, label:'Warren G',  artist_lock:'Warren G'      },

  // R&B / SOUL
  { query: 'Whitney Houston karaoke',           genre:'rnb', era:'80s90s', decade_min:1985, decade_max:2009, label:'Whitney',      artist_lock:'Whitney Houston'},
  { query: 'Mariah Carey karaoke',              genre:'rnb', era:'80s90s', decade_min:1990, decade_max:2005, label:'Mariah',       artist_lock:'Mariah Carey'  },
  { query: 'Usher karaoke instrumental',        genre:'rnb', era:'2000s',  decade_min:1997, decade_max:2012, label:'Usher',        artist_lock:'Usher'         },
  { query: 'Alicia Keys karaoke',               genre:'rnb', era:'2000s',  decade_min:2001, decade_max:2016, label:'Alicia Keys',  artist_lock:'Alicia Keys'   },
  { query: 'Amy Winehouse karaoke',             genre:'rnb', era:'2000s',  decade_min:2003, decade_max:2011, label:'Amy Winehouse',artist_lock:'Amy Winehouse' },
  { query: 'The Weeknd karaoke',                genre:'rnb', era:'modern', decade_min:2012, decade_max:2029, label:'The Weeknd',   artist_lock:'The Weeknd'    },
  { query: 'SZA karaoke instrumental',          genre:'rnb', era:'modern', decade_min:2017, decade_max:2029, label:'SZA',          artist_lock:'SZA'           },

  // SOUL / MOTOWN
  { query: 'Aretha Franklin karaoke',           genre:'soul', era:'60s70s', decade_min:1960, decade_max:1985, label:'Aretha', artist_lock:'Aretha Franklin'},
  { query: 'Marvin Gaye karaoke',               genre:'soul', era:'60s70s', decade_min:1960, decade_max:1984, label:'Marvin', artist_lock:'Marvin Gaye'    },
  { query: 'Stevie Wonder karaoke',             genre:'soul', era:'60s70s', decade_min:1963, decade_max:1985, label:'Stevie', artist_lock:'Stevie Wonder'  },
  { query: 'James Brown karaoke instrumental',  genre:'soul', era:'60s70s', decade_min:1960, decade_max:1985, label:'James',  artist_lock:'James Brown'    },
  { query: 'Otis Redding karaoke',              genre:'soul', era:'60s70s', decade_min:1962, decade_max:1968, label:'Otis',   artist_lock:'Otis Redding'   },

  // COUNTRY
  { query: 'Shania Twain karaoke instrumental', genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania 1', artist_lock:'Shania Twain' },
  { query: 'Shania Twain karaoke',              genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania 2', artist_lock:'Shania Twain' },
  { query: 'Shania Twain backing track',        genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania 3', artist_lock:'Shania Twain' },
  { query: '"Shania Twain" instrumental',       genre:'country', era:'80s90s', decade_min:1993, decade_max:2003, label:'Shania 4', artist_lock:'Shania Twain' },
  { query: 'Dolly Parton karaoke instrumental', genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly 1',  artist_lock:'Dolly Parton' },
  { query: 'Dolly Parton karaoke',              genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly 2',  artist_lock:'Dolly Parton' },
  { query: 'Dolly Parton backing track',        genre:'country', era:'60s70s', decade_min:1967, decade_max:1990, label:'Dolly 3',  artist_lock:'Dolly Parton' },
  { query: 'Johnny Cash karaoke instrumental',  genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Cash 1',   artist_lock:'Johnny Cash'  },
  { query: 'Johnny Cash karaoke',               genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Cash 2',   artist_lock:'Johnny Cash'  },
  { query: 'Johnny Cash backing track',         genre:'country', era:'60s70s', decade_min:1955, decade_max:1985, label:'Cash 3',   artist_lock:'Johnny Cash'  },
  { query: 'Garth Brooks karaoke instrumental', genre:'country', era:'80s90s', decade_min:1989, decade_max:2001, label:'Garth 1',  artist_lock:'Garth Brooks' },
  { query: 'Garth Brooks karaoke',              genre:'country', era:'80s90s', decade_min:1989, decade_max:2001, label:'Garth 2',  artist_lock:'Garth Brooks' },
  { query: 'Kenny Rogers karaoke',              genre:'country', era:'60s70s', decade_min:1976, decade_max:1992, label:'Kenny 1',  artist_lock:'Kenny Rogers' },
  { query: 'Kenny Rogers backing track',        genre:'country', era:'60s70s', decade_min:1976, decade_max:1992, label:'Kenny 2',  artist_lock:'Kenny Rogers' },
  { query: 'Luke Bryan karaoke instrumental',   genre:'country', era:'modern', decade_min:2007, decade_max:2029, label:'Luke 1',   artist_lock:'Luke Bryan'   },
  { query: 'Luke Bryan karaoke',                genre:'country', era:'modern', decade_min:2007, decade_max:2029, label:'Luke 2',   artist_lock:'Luke Bryan'   },
  { query: 'Morgan Wallen karaoke',             genre:'country', era:'modern', decade_min:2018, decade_max:2029, label:'Morgan 1', artist_lock:'Morgan Wallen'},
  { query: 'Morgan Wallen instrumental',        genre:'country', era:'modern', decade_min:2018, decade_max:2029, label:'Morgan 2', artist_lock:'Morgan Wallen'},
  { query: 'Karaoke Hits country 80s 90s',      genre:'country', era:'80s90s', decade_min:1980, decade_max:1999, label:'Country 80s-90s' },
  { query: 'Karaoke Hits country 2000s',        genre:'country', era:'2000s',  decade_min:2000, decade_max:2009, label:'Country 2000s'   },

  // DANCE
  { query: 'Daft Punk karaoke instrumental',    genre:'dance', era:'2000s',  decade_min:1997, decade_max:2013, label:'Daft Punk',    artist_lock:'Daft Punk'    },
  { query: 'Calvin Harris karaoke',             genre:'dance', era:'modern', decade_min:2007, decade_max:2029, label:'Calvin Harris',artist_lock:'Calvin Harris' },
  { query: 'David Guetta karaoke',              genre:'dance', era:'modern', decade_min:2009, decade_max:2029, label:'David Guetta', artist_lock:'David Guetta'  },
  { query: 'Avicii karaoke instrumental',       genre:'dance', era:'modern', decade_min:2011, decade_max:2018, label:'Avicii',       artist_lock:'Avicii'        },
  { query: 'Karaoke dance hits 2000s',          genre:'dance', era:'2000s',  decade_min:2000, decade_max:2009, label:'Dance 2000s'  },
  { query: 'Karaoke dance hits 2010s',          genre:'dance', era:'modern', decade_min:2010, decade_max:2019, label:'Dance 2010s'  },

  // SOUNDTRACKS
  { query: 'Grease karaoke instrumental',              genre:'soundtracks', era:'60s70s', decade_min:1978, decade_max:1979, label:'Grease'           },
  { query: 'Dirty Dancing karaoke instrumental',       genre:'soundtracks', era:'80s90s', decade_min:1987, decade_max:1988, label:'Dirty Dancing'    },
  { query: 'Footloose karaoke instrumental',           genre:'soundtracks', era:'80s90s', decade_min:1984, decade_max:1985, label:'Footloose'        },
  { query: 'Mamma Mia movie karaoke',                  genre:'soundtracks', era:'modern', decade_min:2008, decade_max:2019, label:'Mamma Mia'        },
  { query: 'Greatest Showman karaoke',                 genre:'soundtracks', era:'modern', decade_min:2017, decade_max:2018, label:'Greatest Showman' },
  { query: 'La La Land karaoke instrumental',          genre:'soundtracks', era:'modern', decade_min:2016, decade_max:2017, label:'La La Land'       },
  { query: 'Encanto karaoke instrumental',             genre:'soundtracks', era:'modern', decade_min:2021, decade_max:2022, label:'Encanto'          },
  { query: 'Moana karaoke instrumental',               genre:'soundtracks', era:'modern', decade_min:2016, decade_max:2017, label:'Moana'            },
  { query: 'Frozen karaoke instrumental',              genre:'soundtracks', era:'modern', decade_min:2013, decade_max:2020, label:'Frozen'           },
  { query: 'Guardians Galaxy karaoke',                 genre:'soundtracks', era:'modern', decade_min:2014, decade_max:2019, label:'Guardians'        },
  { query: 'Disney karaoke instrumental',              genre:'soundtracks', era:'modern', decade_min:1989, decade_max:2029, label:'Disney Mix'       },
];

// ─── Schema ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS songs (' +
    '  id           SERIAL PRIMARY KEY,' +
    '  title        TEXT        NOT NULL,' +
    '  artist       TEXT        NOT NULL,' +
    '  era          TEXT        NOT NULL DEFAULT \'modern\',' +
    '  genre        TEXT,' +
    '  decade       SMALLINT,' +
    '  deezer_query TEXT        NOT NULL,' +
    '  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,' +
    '  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()' +
    ')'
  );
  await pool.query('ALTER TABLE songs ADD COLUMN IF NOT EXISTS genre TEXT').catch(() => {});
  await pool.query('ALTER TABLE songs DROP COLUMN IF EXISTS preview_cache').catch(() => {});
  await pool.query('ALTER TABLE songs DROP COLUMN IF EXISTS preview_cached_at').catch(() => {});
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_title_artist_unique ' +
    'ON songs (lower(title), lower(artist))'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_era_enabled   ON songs (era, enabled)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_genre_enabled ON songs (genre, enabled)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_songs_enabled       ON songs (enabled)');
}

// ─── Main ingest ──────────────────────────────────────────────────────────────
async function ingestFromDeezer(options) {
  const force = options && options.force;
  await ensureSchema();

  const countRes = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  const existing = parseInt(countRes.rows[0].n);

  if (!force && existing >= 100) {
    console.log('Catalog has ' + existing + ' songs — skipping ingest');
    return { skipped: true, existing };
  }

  console.log('Starting ingest (' + existing + ' in DB)...');
  console.log('Pre-seeded years: ' + KNOWN_YEAR_MAP.size + ' songs | MusicBrainz used for unknown songs only');

  const started = Date.now();
  let totalInserted = 0, totalRejected = 0, errors = 0;

  for (const source of SOURCES) {
    try {
      const tracks  = await fetchInstrumentalTracks(source.query);
      const { inserted, rejected } = await insertTracks(tracks, source);
      totalInserted += inserted;
      totalRejected += rejected;
      if (tracks.length > 0 || inserted > 0) {
        console.log(
          '  [' + source.genre + '] ' + source.label +
          ': fetched=' + tracks.length + ' inserted=' + inserted + ' rejected=' + rejected
        );
      }
    } catch (err) {
      errors++;
      console.warn('  FAIL ' + source.label + ': ' + err.message);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const finalRes = await pool.query('SELECT COUNT(*) AS n FROM songs WHERE enabled = true');
  console.log('Ingest done in ' + elapsed + 's — ' + finalRes.rows[0].n + ' songs, ' + totalRejected + ' rejected');
  return { totalInserted, totalRejected, total: parseInt(finalRes.rows[0].n), elapsed, errors };
}

module.exports = { ingestFromDeezer, ensureSchema };
