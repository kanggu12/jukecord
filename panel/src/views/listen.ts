/**
 * Listening in this browser: the bar at the bottom of the window and the audio behind it.
 *
 * The server's player is the clock. This browser loads the playing track's file and keeps its own playback within
 * 300 ms of where the server says the track is (the voice channel follows the same clock), checking every two
 * seconds and after every change. It plays Ogg Opus where the browser can, and the MP3 copy where it cannot (or when
 * Opus fails to play). The system's media keys and lock screen controls drive the same actions as the panel.
 *
 * Safari plays an element later only if play() ran during a press, so the Listen key calls it right there (muted for
 * a moment when the music is paused); the position is set once the file is known.
 */
import { api, coverUrl, type Player } from '../api.ts';
import { avatarUrl, face, fill, h, icon, refill, setOff } from '../dom.ts';
import type { Live } from '../live.ts';
import { keep, mayControl, positionNow, state, t, update, watch } from '../state.ts';
import { followMusic } from './light.ts';
import { act, disc, listenerName } from './player.ts';
import { sleepKey } from './sleep.ts';

// How far this browser may drift from the server before it jumps back in line.
const DRIFT_MS = 300;

type Sync = 'off' | 'waiting' | 'catching' | 'in-sync' | 'blocked' | 'failed';

/** The listening bar; also starts the audio engine. */
export function listenBar(live: Live): HTMLElement {
  const audio = new Audio();
  audio.preload = 'auto';
  // In the page (hidden), where the browser's media controls and tests can find it.
  audio.hidden = true;
  audio.id = 'listen-audio';
  document.body.append(audio);
  // The light follows this audio's low end while it plays here (light.ts).
  followMusic(audio);
  // Opus in Ogg where the browser plays it; older Safari does not, and gets MP3.
  let format: 'opus' | 'mp3' = audio.canPlayType('audio/ogg; codecs="opus"') ? 'opus' : 'mp3';
  let loaded: string | null = null;
  let sync: Sync = 'off';
  // How loud the sound is as a share of the volume chosen: below 1 only while the sleep timer fades it out.
  let fade = 1;

  const toggle = h('button', { class: 'key', type: 'button', 'data-act': 'listen' });
  // Three bars that dance on the Listen key while the sound plays here, each a box of its own so that only its scale
  // moves (the browser does that without drawing anything again).
  const eq = h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  // Pause and skip, made once and kept: keys rebuilt on every snapshot would lose a click and the keyboard focus.
  const pauseKey = h('button', { class: 'key square', type: 'button' });
  const skipKey = h('button', { class: 'key square', type: 'button' }, icon('skip-forward'));
  const mini = h('div', { class: 'mini' }, pauseKey, skipKey);
  const art = h('div');
  const what = h('div', { class: 'what' });
  const status = h('div', { class: 'state' }, art, what);
  const faces = h('div', { class: 'faces' });
  const count = h('span', { class: 'faint num' });
  const slider = h('input', { type: 'range', min: '0', max: '100', step: '1' });
  const level = h('span', { class: 'num' });
  const volume = h('label', { class: 'volume' }, icon('volume-2'), slider, level);
  // The sleep timer: this browser stops listening when it runs out, as the Listen key would stop it (set below, once
  // that is made).
  let stopListening = () => {};
  // And starting it, for a guest's media keys (set with it below).
  let listenOn = () => {};
  const sleep = sleepKey({
    stop: () => stopListening(),
    fade: (level) => {
      fade = level;
      audio.volume = state.volume * fade;
    },
  });
  const bar = h(
    'footer',
    { class: 'listen' },
    toggle,
    sleep,
    status,
    mini,
    h('div', { class: 'faces-box' }, faces, count),
    volume,
  );

  // What the bar says about this browser's playback.
  const setSync = (next: Sync) => {
    if (sync === next) return;
    sync = next;
    draw();
  };

  // The address of a track's audio in the format this browser plays.
  const source = (player: Player) =>
    `/api/v1/guilds/${encodeURIComponent(player.guildId)}/tracks/${player.track?.id}/audio?format=${format}`;

  // Brings the audio in line with the server's player.
  const align = () => {
    const player = state.player;
    if (!state.listening) {
      audio.pause();
      setSync('off');
      return;
    }
    if (!player?.track || player.status === 'idle' || player.status === 'loading') {
      audio.pause();
      setSync('waiting');
      return;
    }
    const url = source(player);
    if (loaded !== url) {
      loaded = url;
      audio.src = url;
      setSync('catching');
      // The position can be set once the browser knows the file; this runs again then.
      audio.onloadedmetadata = () => align();
      return;
    }
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const target = positionNow(player, live.now()) / 1000;
    // At the very end, a moment before the server moves on, or loaded just then: wait for the next track (play() on
    // it would start this one again from the top). A seek back on the server still brings it in line below.
    const atEnd = Number.isFinite(audio.duration) && target >= audio.duration - DRIFT_MS / 1000;
    if (atEnd && (audio.ended || audio.paused) && player.status === 'playing') {
      setSync('waiting');
      return;
    }
    if (Math.abs(audio.currentTime - target) * 1000 > DRIFT_MS) {
      audio.currentTime = target;
      setSync('catching');
    } else if (player.status === 'playing') {
      setSync('in-sync');
    }
    if (player.status === 'paused') {
      audio.pause();
      setSync('in-sync');
      return;
    }
    audio.volume = state.volume * fade;
    if (audio.paused) {
      audio.play().then(
        () => setSync('in-sync'),
        (error: unknown) => {
          const name = (error as DOMException)?.name;
          // A play cut short by the next track's file (AbortError) is not a failure: the next check plays that one. A
          // file that could not be loaded (NotSupportedError) is the error handler's to count and ask for again.
          if (name === 'AbortError' || name === 'NotSupportedError') return;
          // Browsers hold back sound a person has not asked for; a press of the key is that asking.
          setSync(name === 'NotAllowedError' ? 'blocked' : 'failed');
        },
      );
    }
  };

  // Failures of the playing track: the file is asked for again on the next check (the server may be busy making an
  // MP3 copy, or restarting), a second Opus failure switches this page to MP3 (some Safari versions claim Opus and
  // cannot play it), and the fourth says so in the bar. A new track starts the count again. An answer that only says
  // "not now" (503: jukecord is busy; 409: the track is not ready yet) is not counted: the audio element cannot tell
  // it from a format it cannot play, so the server is asked (one byte) before the failure counts.
  let failures = 0;
  let failedTrack: number | null = null;
  audio.onerror = () => {
    const track = state.player?.track?.id ?? null;
    const source = audio.currentSrc || audio.src;
    void notNow(source).then((later) => {
      // A newer track or source meanwhile: this failure is about one no longer played.
      if ((state.player?.track?.id ?? null) !== track || (audio.currentSrc || audio.src) !== source) return;
      if (later) {
        loaded = null;
        setSync('catching');
        return;
      }
      if (track !== failedTrack) {
        failedTrack = track;
        failures = 0;
      }
      failures += 1;
      if (format === 'opus' && failures >= 2) format = 'mp3';
      if (failures >= 4) {
        setSync('failed');
        return;
      }
      loaded = null;
      setSync('catching');
    });
  };
  // Buffering counts as catching up only while a track plays; play() on an empty element fires it too.
  audio.onwaiting = () => {
    if (state.listening && state.player?.status === 'playing') setSync('catching');
  };
  // Playing counts as in time only while the server plays too (the press plays a paused element for a moment).
  audio.onplaying = () => {
    if (state.player?.status === 'playing') setSync('in-sync');
  };

  // The media keys and the lock screen: the same actions as the panel's keys.
  const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
  const guild = () => state.guild?.id ?? '';
  if (session) {
    // A guest changes nothing for the others: its keys start and stop listening here.
    const guest = () => state.me?.kind === 'guest';
    session.setActionHandler('play', () => (guest() ? listenOn() : void act(null, () => api.resume(guild()))));
    session.setActionHandler('pause', () => (guest() ? stopListening() : void act(null, () => api.pause(guild()))));
    session.setActionHandler('nexttrack', () => {
      if (!guest()) void act(null, () => api.skip(guild()));
    });
  }
  const describe = () => {
    const track = state.player?.track;
    if (!session) return;
    // Nothing playing (or another server shown): the lock screen shows nothing rather than the last track.
    if (!track) {
      session.metadata = null;
      return;
    }
    // The lock screen's picture from jukecord's own address too (see coverUrl).
    const cover = coverUrl(state.player?.guildId ?? state.guild?.id ?? '', track);
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.uploader ?? '',
      album: state.guild?.name ?? 'jukecord',
      ...(cover ? { artwork: [{ src: cover }] } : {}),
    });
  };

  // Calls play() inside the press, which is what lets Safari play this element from now on. With the music paused it
  // plays muted for a moment and pauses again; align() sets the position and the sound once the file is known.
  const playFromPress = () => {
    const playing = state.player?.status === 'playing';
    if (!playing) audio.muted = true;
    audio.play().then(
      () => {
        if (!playing) audio.pause();
        audio.muted = false;
      },
      () => {
        // Refused, or nothing to play yet (no track): align() puts the bar right at once.
        audio.muted = false;
        align();
      },
    );
  };

  // A key's icon and words, changed only when they differ: replacing the inside of a key while it is being pressed
  // can lose the click.
  const label = (key: HTMLButtonElement, name: Parameters<typeof icon>[0], words: string, text: boolean) => {
    const sign = `${name}|${words}|${text}`;
    if (key.dataset.sign === sign) return;
    key.dataset.sign = sign;
    // The Listen key keeps its dancing bars (style.css shows them while it is pressed).
    fill(key, icon(name), text ? h('span', { class: 'label' }, words) : null, key === toggle ? eq : null);
    key.title = words;
    key.setAttribute('aria-label', words);
  };

  const draw = () => {
    const words = t();
    const player = state.player;
    // Blocked: the key asks for the sound again (listening stays on).
    const retry = state.listening && sync === 'blocked';
    toggle.setAttribute('aria-pressed', String(state.listening && !retry));
    // The key's bars dance only while sound plays here (in time), and rest while paused or catching up.
    toggle.classList.toggle('sounding', state.listening && sync === 'in-sync' && player?.status === 'playing');
    label(toggle, 'headphones', state.listening && !retry ? words.stopListening : words.listenHere, true);
    // What plays, with this browser's state under it.
    const message = {
      // Browser-only, or the bot in no voice channel: there is no voice channel to speak of.
      off:
        state.status?.mode === 'browser-only'
          ? words.listenOffBrowser
          : state.voice?.current
            ? words.listenOff
            : words.listenOffNoVoice,
      waiting: words.waiting,
      catching: words.catchingUp,
      'in-sync': words.inSync,
      blocked: words.blocked,
      failed: words.listenFailed,
    }[sync];
    // The small disc is built again only when the track or its mode changes: built on every drawing (a volume step,
    // someone joining), it started its turn over each time.
    const mode = player?.status === 'playing' ? 'playing' : player?.status === 'paused' ? 'paused' : 'idle';
    refill(
      art,
      player?.track ? `${player.track.id}|${player.track.thumbnail}|${mode}` : '',
      player?.track ? disc('sm', player.track, mode) : null,
    );
    fill(
      what,
      // One line, cut short with an ellipsis on a narrow bar; the whole title on hover and for screen readers.
      player?.track ? h('b', { title: player.track.title, 'data-clip': 'ok' }, player.track.title) : null,
      // The long "off" hint is left out on phones, where the bar has room for the title and the keys only.
      h(
        'span',
        {
          class: `${sync === 'blocked' || sync === 'failed' ? 'text-bad' : ''} ${sync === 'off' ? 'long' : ''}`.trim(),
        },
        message,
      ),
    );
    // On a phone the now-playing card is far up the page: pause and skip are here too, with the main key's rule:
    // playing or loading shows pause; paused or idle shows play, which also starts a waiting queue.
    const moving = player?.status === 'playing' || player?.status === 'loading';
    const queued = (state.queue?.items.length ?? 0) > 0;
    const pauseWords = moving ? words.pause : player?.status === 'paused' ? words.resume : words.play;
    label(pauseKey, moving ? 'pause' : 'play', pauseWords, false);
    skipKey.title = words.skip;
    skipKey.setAttribute('aria-label', words.skip);
    // A key turned off with the focus on it (Skip on the last track) hands it to the other key, or to Listen here.
    setOff(pauseKey, !player || !mayControl() || (!player.track && !queued), toggle);
    setOff(skipKey, !mayControl() || !player?.track, pauseKey, toggle);
    // A guest has neither: it can never press them.
    mini.hidden = state.me?.kind === 'guest';
    // Nothing playing: the bar has room, so the phone's Listen key says its name too (see style.css).
    bar.classList.toggle('idle', !player?.track);
    // Who else listens: the faces built again only when the people change (their pictures would load again).
    const people = state.listeners.people.slice(0, 5);
    refill(
      faces,
      JSON.stringify(people.map((person) => [person.id, person.name, person.avatar])),
      ...people.map((person) => face(listenerName(person), avatarUrl(person.id, person.avatar), 'sm')),
    );
    count.textContent = state.listeners.count > 0 ? words.listeners(state.listeners.count) : '';
    slider.value = String(Math.round(state.volume * 100));
    slider.setAttribute('aria-label', words.volume);
    level.textContent = `${Math.round(state.volume * 100)}%`;
  };

  pauseKey.onclick = () => {
    const status = state.player?.status ?? 'idle';
    // Paused or idle: play on (or start the queue). Playing or loading: pause.
    void act(pauseKey, () => (status === 'paused' || status === 'idle' ? api.resume(guild()) : api.pause(guild())));
  };
  skipKey.onclick = () => void act(skipKey, () => api.skip(guild()));

  // Listening here on or off, said to the others and kept for this browser.
  const listen = (on: boolean) => {
    update({ listening: on });
    live.listening(on);
    keep('listening', on ? 'on' : 'off');
    if (on) loaded = null;
    // On: loads the playing track. Off: the sound stops now, not at the next snapshot.
    align();
    if (on) playFromPress();
  };
  stopListening = () => {
    if (state.listening) listen(false);
  };
  listenOn = () => {
    if (!state.listening) listen(true);
  };
  toggle.onclick = () => {
    // Blocked: this press is the asking the browser waited for.
    if (state.listening && sync === 'blocked') {
      playFromPress();
      return;
    }
    listen(!state.listening);
  };
  slider.oninput = () => {
    const value = Number(slider.value) / 100;
    audio.volume = value * fade;
    update({ volume: value });
    keep('volume', String(value));
  };

  watch(['player'], () => {
    describe();
    align();
  });
  watch(['player', 'listeners', 'lang', 'listening', 'volume', 'me', 'guild', 'status', 'queue', 'voice'], draw);
  // Drift is checked every two seconds while listening.
  window.setInterval(() => {
    if (state.listening) align();
  }, 2000);
  draw();
  return bar;
}

// Whether jukecord answers a track's address with "not now" (busy, or not ready yet) rather than with the audio.
async function notNow(source: string): Promise<boolean> {
  if (!source) return false;
  try {
    const answer = await fetch(source, { headers: { range: 'bytes=0-0' }, credentials: 'same-origin' });
    // Only the status is wanted; the one byte (or the refusal) is left unread.
    void answer.body?.cancel();
    return answer.status === 503 || answer.status === 409;
  } catch {
    // jukecord not answering at all is a lost connection, which the live connection already says.
    return true;
  }
}
