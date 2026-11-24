/**
 * The numbers of a split jukecord's own parts, beside what an edge's commands and the shared cache report through
 * src/metrics/services.ts: the commands the core ran for its edges, the events that travel the bus, and how many
 * edges report to the core. Each part declares its family where it is made (a family declared again is the same one),
 * and tests/support/metrics.ts declares them all, for the dashboard's and the alerts' checks.
 */
import type { Counter, Gauge, Metrics } from '../metrics/registry.ts';

/** At the core: the commands it ran for the edges, by command and how they ended (ok, refused, failed, late). */
export function servedCommands(metrics: Metrics): Counter {
  return metrics.counter(
    'jukecord_bus_commands_served_total',
    'Commands the core ran for its edges, by command and how they ended: ok, refused (the action said no), failed, late (its caller had stopped waiting).',
    ['command', 'outcome'],
  );
}

/** At the core and at every edge: the events of the core's bus and the endings of live connections, sent or heard. */
export function busEvents(metrics: Metrics): Counter {
  return metrics.counter(
    'jukecord_bus_events_total',
    'Events that travel the bus (the core to its edges, and endings of live connections), by event and outcome: sent, lost (the bus was down), received.',
    ['event', 'outcome'],
  );
}

/** At the core: the edges that report who listens in their browsers (every running edge does, every few seconds). */
export function reportingEdges(metrics: Metrics): Gauge {
  return metrics.gauge(
    'jukecord_edges',
    'Edges of a split jukecord that report to the core (each one does every few seconds while it runs).',
  );
}
