# Security

## Reporting a vulnerability

Please report a security problem privately: on GitHub, open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue for it.

Say what an attacker can do, how to reproduce it, and which version you ran (a release tag or a commit). The
maintainer will reply, agree on a fix with you, and publish an advisory with the fixed release. The advisory credits
you unless you ask not to be named.

The latest release and `main` get security fixes.

## What matters most

jukecord holds a Discord bot's token, lets people control music from a browser, and runs yt-dlp and ffmpeg on
addresses people type. These matter most:

- reading or using the bot token, the OAuth secret, the host token, a session or an API token from outside;
- doing as another login, or in a server one is not a member of, or changing the music without the DJ role;
- a change made through someone's panel session by another site (the CSRF header and the WebSocket origin check);
- an address or a search that makes yt-dlp or ffmpeg do more than fetch and convert audio;
- a track title, a name or any other text from a site or from Discord that makes the panel run script;
- reaching other services from jukecord's pod past the chart's NetworkPolicy.

The panel is published on 127.0.0.1 by default. Publishing it to a network is supported (logins protect it), behind
HTTPS when it leaves the local network.
