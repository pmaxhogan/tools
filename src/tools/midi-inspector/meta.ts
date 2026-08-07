import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'midi-inspector',
  icon: 'Piano',
  name: 'MIDI Inspector',
  description: 'Read a .mid file event by event, or watch a live MIDI device, all in your browser.',
  category: 'Dev',
  keywords: [
    'midi file viewer',
    'read midi file online',
    'smf parser',
    'midi event list',
    'web midi monitor',
    'inspect midi',
    'midi note events',
    'midi tempo and time signature',
  ],
  searchTerms: [
    'midi file viewer',
    'read midi',
    'smf parser',
    'web midi monitor',
    'midi events',
    'note events',
    'standard midi file',
    'midi debugger',
    'midi tester',
    'midi monitor',
  ],
  input: 'File',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'middleC',
      label: 'Middle C octave',
      default: '4',
      choices: [
        { value: '3', label: 'C3 is note 60 (Yamaha style)' },
        { value: '4', label: 'C4 is note 60 (scientific)' },
        { value: '5', label: 'C5 is note 60' },
      ],
    },
  ],
  copy: {
    what: 'Opens a Standard MIDI File, .mid or .midi, and shows what is inside it: the header format, the track count, and the timing division in ticks per quarter note or SMPTE frames. For each track it lists the events in order, with note on and note off decoded to real note names and velocities, control changes and program changes named, and the tempo, time signature and key signature meta events read out. It counts the sounding notes, works out the playback length from the tempo map, and pulls out every track name. There is also a live monitor that lists the MIDI input devices plugged into your computer and streams their messages as you play, with an option to hear the notes through the browser.',
    how: 'Drop a .mid file onto the file panel or pick one with the button, and the summary and event list appear at once. Switch to the live monitor tab to grant MIDI access, choose an input device, and play: note names, velocities, control changes and pitch bend scroll into the log in real time, and you can turn on a simple synth to hear each note. Copy buttons sit next to the values you are likely to want. The middle C octave option changes only the labels, since programs disagree on whether note 60 is C3 or C4.',
    why: 'Most MIDI viewers online ask you to upload the file to a server before they will show you a single note, and the live monitors are native apps you have to install. This one parses the file in the page and reads your devices with the browser Web MIDI API, so your files and inputs never leave your device. It writes its own SMF parser rather than leaning on a black box, so running status, variable length delta times and the SMPTE division are all handled correctly, and there are no ads, upload limits, or a paywall over the event list.',
    faq: [
      {
        q: 'Does the live monitor work in every browser?',
        a: 'The file inspector works everywhere. The live monitor needs the Web MIDI API, which Chrome, Edge and other Chromium browsers support, and Firefox behind a flag. Safari does not expose it, so on Safari the monitor shows an honest message while the file inspector stays fully usable.',
      },
      {
        q: 'Why do the note names look an octave off?',
        a: 'There is no agreed standard for which octave MIDI note 60 belongs to. Scientific pitch notation calls it C4, while many Yamaha and older sequencers call it C3. Use the middle C octave option to match whatever your DAW shows. The note numbers themselves never change, only the label.',
      },
      {
        q: 'Can it read karaoke or compressed MIDI files?',
        a: 'It reads Standard MIDI Files, the .mid and .midi format, including the lyrics and text events a karaoke file stores. It does not unpack the compressed .kar wrapper some karaoke tools use, or the XMF container, and it is not for audio like .mp3 or .wav, which are recordings rather than MIDI event data.',
      },
    ],
  },
};
