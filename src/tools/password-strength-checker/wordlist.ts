/**
 * The bundled dictionary, ordered by how common each entry is: index 0 is the
 * most guessed, so a match's rank is a direct estimate of how many guesses an
 * attacker working through a list like this would need before reaching it.
 *
 * Three lists, kept separate so a match can say which one it came from.
 * They are deliberately small (roughly one thousand entries in total) because
 * they ship to every visitor: a real cracking rig uses a list of billions, and
 * the FAQ says so rather than pretending this is the same thing.
 *
 * US English throughout, and no word that a British spelling check would flag.
 */

/** Leaked passwords, roughly in frequency order from published breach reports. */
const PASSWORDS = `123456 password 123456789 12345678 12345 111111 1234567 sunshine qwerty
iloveyou princess admin welcome 666666 abc123 football 123123 monkey 654321 !@#$%^&*
charlie aa123456 donald password1 qwerty123 letmein zxcvbnm login starwars 121212
bailey freedom shadow passw0rd master qwertyuiop jordan jennifer hunter buster soccer
harley batman andrew tigger dragon michael computer jessica pepper 1111 zxcvbn 555555
11111111 131313 freedom777 pass maggie 159753 aaaaaa ginger princess1 joshua cheese
amanda summer love ashley nicole chelsea biteme matthew access yankees 987654321
dallas austin thunder taylor matrix mobilemail mom monitor monitoring montana moon moscow
1234 12345678910 000000 asdfgh 1q2w3e4r qazwsx trustno1 dragon1 1qaz2wsx killer jesus
hello whatever nothing thomas hockey ranger daniel hannah maggie1 michelle jordan23
superman 1234567890 photoshop 123qwe purple andrea horses tigers porsche guitar chicken
maverick chicago joseph diablo sexy hardcore 666999 secret dennis matrix1 corvette
bandit orange test blue lovely 7777777 anthony friends butterfly ferrari samsung
liverpool cookie naruto brandon steelers gateway pokemon merlin william ginger1 heather
peanut asdf mustang mickey samantha bubbles nascar golfer sparky yellow camaro
scooter carlos boomer justin morgan rangers robert benjamin trinity midnight college
baseball melissa panther cowboys iceman spider phoenix cameron amanda1 nicholas
victoria hunter1 patrick brandy compaq internet service canada hello123 ranger1
please password123 flower jasmine banana chocolate abcd1234 asdfghjk qwe123 zaq12wsx
sophie oliver charlie1 george arsenal chelsea1 barcelona real madrid manchester
starwars1 dolphin marina scotland ncc1701 rachel amber angel angels arthur august
austin1 badboy barney bigdog birdie blazer bond007 boston brandon1 bronco brooklyn
bulldog calvin captain cardinal carter casper chester cocacola cooper cowboy crystal
dakota dave debbie dexter diamond digital doctor doggie dolphins donna dreams driver
eagle eagles edward einstein elephant enter eric erotic explorer extreme falcon fender
fire fish fishing flowers florida forever fortune frank fred gandalf garden gemini
general genius golden golf gordon green greenday gregory guinness gunner hammer happy
helpme henry hentai hockey1 hooters horny house iceman1 idontknow indian iwantu jack
jackie jackson jaguar jake james jason jasper jeremy jerry jessie jesus1 john johnny
johnson jonathan joseph1 juice junior justin1 kelly kevin kimberly king knight
lakers lauren leather legend lestat little logan london lucky lucky7 madison magic
magnum marine mark marlboro martin marvin master1 matt maxwell melanie member mercedes
merlin1 miller mine mistress money monster mountain movie muffin murphy music mustang1
nathan nemesis newyork nicholas1 nipples nissan oliver1 online orange1 packers panties
paris parker patricia paul peaches peanut1 pearljam peter phantom phoenix1 pierre
player please1 pookie porsche1 power prince private prometheus python queen qwert
rabbit racing raiders rainbow raider ranger12 rebecca redskins redsox reddog richard
rick robert1 rocket rocky rosebud runner rush2112 russia samson sandra saturn scooby
scorpio scotty scott september sergey shannon shaved shelly sierra silver skippy
slayer smokey snoopy sniper spanky sparky1 spider1 spitfire squirt srinivas star
steve steven sticky stupid success suckit summer1 super surfer swimming sydney
teens tennis teresa test1 tester theman thomas1 thunder1 tiffany tigger1 time titanic
tomcat topgun toyota travis trouble tucker turtle united vagina victor video viking
voodoo voyager walter warrior weather wizard wolf women xavier xxxxxx yamaha yankee
young zeppelin zombie hello1 changeme default guest root oracle postgres mysql
administrator manager operator system server database backup temporary temp qwaszx
1q2w3e 1qaz2wsx3edc a1b2c3 asdasd 121314 abcdef abcdefg letmein1 letmein123 passwd
p@ssw0rd p@ssword pa55word secret1 welcome1 welcome123 admin123 admin1 root123
test123 demo sample example changeit trustme opensesame iloveyou1 princess123`;

/** English words common enough that a cracker's wordlist certainly contains them. */
const WORDS = `the be to of and in that have it for not on with he as you do at this but his by
from they we say her she or an will my one all would there their what so up out if
about who get which go me when make can like time no just him know take people into
year your good some could them see other than then now look only come its over think
also back after use two how our work first well way even new want because any these
give day most us man find here thing life world tell try ask need feel become leave
put mean keep let begin seem help talk turn start show hear play run move live believe
bring happen write provide sit stand lose pay meet include continue set learn change
lead understand watch follow stop create speak read allow add spend grow open walk
win offer remember love consider appear buy wait serve die send expect build stay
fall cut reach kill remain suggest raise pass sell require report decide pull house
water river lake ocean mountain forest garden flower tree grass stone metal fire
earth wind storm cloud rain snow winter spring summer autumn morning evening night
music guitar piano drum song dance movie book story poem paper pencil letter number
school teacher student office worker doctor nurse driver pilot farmer baker artist
coffee tea bread cheese apple orange banana grape lemon potato tomato carrot onion
chicken salmon pepper sugar honey butter chocolate cookie cake pizza burger noodle
dog cat horse bird fish mouse rabbit tiger lion bear wolf fox deer sheep cow pig
happy sad angry quiet loud fast slow big small long short hard soft warm cold
bright dark clean dirty heavy light strong weak young old rich poor easy simple
red blue green yellow purple orange black white silver golden bronze copper
north south east west center left right front back inside outside above below
monday tuesday wednesday thursday friday saturday sunday january february march
april june july august september october november december
soccer tennis rugby cricket hockey baseball boxing running cycling swimming
london paris berlin madrid rome dublin lisbon vienna prague warsaw moscow tokyo
beijing seoul sydney toronto boston chicago denver seattle austin dallas atlanta
miami phoenix portland houston detroit memphis nashville orlando vegas
james mary john patricia michael jennifer william elizabeth david barbara richard
susan joseph jessica thomas sarah charles karen christopher nancy daniel lisa
matthew betty anthony margaret mark sandra donald ashley steven kimberly andrew
emily joshua donna kenneth michelle kevin carol brian amanda george melissa edward
deborah ronald stephanie timothy rebecca jason laura jeffrey sharon ryan cynthia
jacob kathleen gary amy nicholas shirley eric angela stephen anna jonathan brenda
larry pamela justin nicole scott samantha brandon katherine benjamin christine
samuel emma gregory catherine alexander debra patrick rachel frank carolyn`;

/**
 * Common keyboard walks and repeated shapes people believe are random. These
 * are checked as whole-token dictionary entries in addition to the geometric
 * keyboard walk detector, which catches the ones nobody thought to list.
 */
const KEYBOARD_PATTERNS = `qwerty qwertyui asdfgh asdfghjk zxcvbn zxcvbnm qazwsx qazwsxedc
1qaz2wsx 1q2w3e 1q2w3e4r 1q2w3e4r5t qwer asdf zxcv poiuy lkjh mnbv qweasd qweasdzxc
147258369 159357 741852963 123321 112233 456789 0987654321 1234qwer qwer1234
zaq12wsx xsw2 cde34 vfr4 bgt5 nhy6 mju7 azerty qwertz wasd`;

function split(source: string): string[] {
  return source.split(/\s+/).filter((word) => word.length > 0);
}

export const PASSWORD_LIST: string[] = split(PASSWORDS);
export const WORD_LIST: string[] = split(WORDS);
export const KEYBOARD_LIST: string[] = split(KEYBOARD_PATTERNS);

export type DictionaryName = "passwords" | "words" | "keyboard";

export const DICTIONARY_LABEL: Record<DictionaryName, string> = {
  passwords: "leaked password list",
  words: "common English words",
  keyboard: "known keyboard pattern",
};

/** word -> its 1-based rank inside one dictionary. Lower rank means guessed sooner. */
export type RankedDictionary = Map<string, number>;

function rank(words: string[]): RankedDictionary {
  const map: RankedDictionary = new Map();
  words.forEach((word, index) => {
    const key = word.toLowerCase();
    if (!map.has(key)) map.set(key, index + 1);
  });
  return map;
}

export const DICTIONARIES: ReadonlyArray<readonly [DictionaryName, RankedDictionary]> = [
  ["passwords", rank(PASSWORD_LIST)],
  ["words", rank(WORD_LIST)],
  ["keyboard", rank(KEYBOARD_LIST)],
];

/** Length of the longest entry in any dictionary, so matching can stop early. */
export const MAX_DICTIONARY_WORD = Math.max(
  ...[...PASSWORD_LIST, ...WORD_LIST, ...KEYBOARD_LIST].map((w) => w.length),
);
