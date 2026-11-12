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
import { api, type Player } from '../api.ts';
import { avatarUrl, face, fill, h, icon } from '../dom.ts';
import type { Live } from '../live.ts';
import { keep, mayControl, positionNow, state, t, update, watch } from '../state.ts';
import { act, disc } from './player.ts';

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
  // Opus in Ogg where the browser plays it; older Safari does not, and gets MP3.
  let format: 'opus' | 'mp3' = audio.canPlayType('audio/ogg; codecs="opus"') ? 'opus' : 'mp3';
  let loaded: string | null = null;
  let sync: Sync = 'off';

  const toggle = h('button', { class: 'key', type: 'button', 'data-act': 'listen' });
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
  const bar = h(
    'footer',
    { class: 'listen' },
    toggle,
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
    audio.volume = state.volume;
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
  // cannot play it), and the fourth says so in the bar. A new track starts the count again.
  let failures = 0;
  let failedTrack: number | null = null;
  audio.onerror = () => {
    const track = state.player?.track?.id ?? null;
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
    session.setActionHandler('play', () => void act(null, () => api.resume(guild())));
    session.setActionHandler('pause', () => void act(null, () => api.pause(guild())));
    session.setActionHandler('nexttrack', () => void act(null, () => api.skip(guild())));
  }
  const describe = () => {
    const track = state.player?.track;
    if (!session) return;
    // Nothing playing (or another server shown): the lock screen shows nothing rather than the last track.
    if (!track) {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.uploader ?? '',
      album: state.guild?.name ?? 'jukecord',
      ...(track.thumbnail ? { artwork: [{ src: track.thumbnail }] } : {}),
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
    fill(key, icon(name), text ? h('span', { class: 'label' }, words) : null);
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
      off: state.status?.mode === 'browser-only' ? words.listenOffBrowser : words.listenOff,
      waiting: words.waiting,
      catching: words.catchingUp,
      'in-sync': words.inSync,
      blocked: words.blocked,
      failed: words.listenFailed,
    }[sync];
    fill(
      art,
      player?.track
        ? disc(
            'sm',
            player.track,
            player.status === 'playing' ? 'playing' : player.status === 'paused' ? 'paused' : 'idle',
          )
        : null,
    );
    fill(
      what,
      player?.track ? h('b', null, player.track.title) : null,
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
    pauseKey.disabled = !player || !mayControl() || (!player.track && !queued);
    skipKey.disabled = !mayControl() || !player?.track;
    // Nothing playing: the bar has room, so the phone's Listen key says its name too (see style.css).
    bar.classList.toggle('idle', !player?.track);
    // Who else listens.
    const people = state.listeners.people;
    fill(faces, ...people.slice(0, 5).map((person) => face(person.name, avatarUrl(person.id, person.avatar), 'sm')));
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

  toggle.onclick = () => {
    // Blocked: this press is the asking the browser waited for.
    if (state.listening && sync === 'blocked') {
      playFromPress();
      return;
    }
    const on = !state.listening;
    update({ listening: on });
    live.listening(on);
    keep('listening', on ? 'on' : 'off');
    if (on) loaded = null;
    // On: loads the playing track. Off: the sound stops now, not at the next snapshot.
    align();
    if (on) playFromPress();
  };
  slider.oninput = () => {
    const value = Number(slider.value) / 100;
    audio.volume = value;
    update({ volume: value });
    keep('volume', String(value));
  };

  watch(['player'], () => {
    describe();
    align();
  });
  watch(['player', 'listeners', 'lang', 'listening', 'volume', 'me', 'guild', 'status', 'queue'], draw);
  // Drift is checked every two seconds while listening.
  window.setInterval(() => {
    if (state.listening) align();
  }, 2000);
  draw();
  return bar;
}
