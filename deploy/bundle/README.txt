jukecord @VERSION@ for @SYSTEM@

A self-hosted Discord music bot: one queue, heard in a voice channel and in the browser at the same time. This folder
is all it needs: jukecord, with its own Node.js, FFmpeg and yt-dlp in lib.

  @RUN@ start     run jukecord in this terminal, until Ctrl+C
  @RUN@ open      log in to the panel from this computer (in a second terminal)
  @RUN@ help      every command

To play in a Discord voice channel too, copy .env.example to .env, set JUKECORD_DISCORD_TOKEN and start it again:
https://github.com/kanggu12/jukecord#the-discord-bot says how to make the bot. The panel's Settings page, in the
host's menu, changes settings while jukecord runs, and its Restart works under "@RUN@ start".

The data and the settings saved from the panel stay in @DATA@ (JUKECORD_DATA_DIR in .env moves them), and
JUKECORD_DATABASE_URL in .env puts the database on a PostgreSQL or MySQL/MariaDB server instead. For a newer release,
unpack it beside this folder and copy .env into it: it finds the same data.

Guide: https://github.com/kanggu12/jukecord/blob/main/docs/INSTALL.md#without-docker
Licences: LICENSE (jukecord, MIT) and THIRD_PARTY_NOTICES.md (Node.js, FFmpeg, yt-dlp and the rest).
