// Runs before the page draws (a plain script in <head>, not a module), so a chosen theme shows without a flash of
// the other one. The panel's own code keeps the same setting afterwards (panel/src/main.ts).
try {
  const theme = localStorage.getItem('jukecord.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked (a private window): the system's theme it is.
}
