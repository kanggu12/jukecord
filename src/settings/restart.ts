/**
 * Restarting jukecord from the panel, the API or `jukecord restart`: it stops as it does on SIGTERM (the players'
 * places saved, the panels told, Discord left, the database closed) and exits with RESTART_EXIT_CODE, for whatever
 * runs it to start it again. What does is known from the deployment or from where jukecord runs:
 *
 * - docker: Compose sets JUKECORD_SUPERVISOR=docker, its restart policy (unless-stopped) starts the container again;
 * - kubernetes: a pod's container is started again by its kubelet (KUBERNETES_SERVICE_HOST is in every pod);
 * - systemd: a unit with Restart=on-failure or always starts it again, when it sets JUKECORD_SUPERVISOR=systemd (a
 *   unit's own process cannot tell: systemd's default is Restart=no, which leaves it stopped);
 * - launcher: the program's `jukecord start` starts it again on that exit code (it sets JUKECORD_SUPERVISOR=launcher);
 * - none: nothing would, as in a terminal running it by hand; a restart is refused, saying so.
 */
import type { Supervisor } from '../config.ts';

/** The exit code of a restart: EX_TEMPFAIL, "try again"; not 0, which systemd's Restart=on-failure would leave stopped. */
export const RESTART_EXIT_CODE = 75;

/** What starts jukecord again after it exits for a restart: as the setting says, or found out from where it runs. */
export function supervisorOf(setting: Supervisor | null, env: NodeJS.ProcessEnv): Supervisor {
  if (setting !== null) return setting;
  // Every pod has its cluster's API address in its environment, and a pod's containers are started again by default.
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  // Not systemd from its own variables: a unit starts jukecord again only when it says Restart=, which nothing in the
  // process shows; the unit says JUKECORD_SUPERVISOR=systemd with it.
  return 'none';
}

/** Why a restart cannot be asked for here, or null when something starts jukecord again. */
export function restartRefusal(supervisor: Supervisor): string | null {
  return supervisor === 'none'
    ? 'nothing would start jukecord again here (it runs without a supervisor, as in a terminal): stop it and start it yourself'
    : null;
}
