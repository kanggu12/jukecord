/**
 * The OpenAPI 3.1 document of the API, built from the operation table (src/web/api.ts) and served at
 * /api/v1/openapi.json. docs/API.md is checked against it, so the document and the prose cannot drift apart.
 *
 * Schemas with a title (Track, Player, ...) become components and are referred to by name, which keeps the document
 * readable; OpenAPI 3.1 uses JSON Schema 2020-12, so the TypeBox schemas go in as they are.
 */
import type { TSchema } from 'typebox';
import { VERSION } from '../version.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec } from './api.ts';
import { ErrorSchema } from './schemas.ts';

type Json = Record<string, unknown>;

// Replaces every schema that has a title with a reference to a component of that name, collecting the components.
// The same schema meets this function many times (Track is inside half the answers); each time gives the same body.
function referenced(schema: unknown, components: Map<string, Json>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => referenced(item, components));
  if (!schema || typeof schema !== 'object') return schema;
  // A plain copy: TypeBox keeps a hidden "~kind" key that JSON leaves out.
  const plain = JSON.parse(JSON.stringify(schema)) as Json;
  // The children first, so a component's own body refers to the components inside it.
  const body: Json = {};
  for (const [key, value] of Object.entries(plain)) body[key] = referenced(value, components);
  // Property schemas named "title" are a field called title, not a schema's title: only strings are titles.
  if (typeof plain.title === 'string') {
    components.set(plain.title, body);
    return { $ref: `#/components/schemas/${plain.title}` };
  }
  return body;
}

// The path parameters, query parameters and body of one operation in OpenAPI's form.
function parameters(spec: OperationSpec, components: Map<string, Json>): Json[] {
  const list: Json[] = [];
  const add = (where: 'path' | 'query', schema: TSchema | undefined) => {
    if (!schema) return;
    const object = JSON.parse(JSON.stringify(schema)) as { properties?: Json; required?: string[] };
    for (const [name, property] of Object.entries(object.properties ?? {})) {
      list.push({
        name,
        in: where,
        // Path parameters are always required; query ones only when the schema says so.
        required: where === 'path' || (object.required ?? []).includes(name),
        schema: referenced(property, components),
      });
    }
  };
  add('path', spec.params);
  add('query', spec.query);
  return list;
}

// The answers every operation can give besides 200, by HTTP status.
const ERRORS: Readonly<Record<string, string>> = {
  '400': 'The request is not valid (code "invalid")',
  '401': 'Not logged in, or the token is not valid (code "unauthorized")',
  '403': 'Not allowed: the DJ role, the scope of the token, or a missing CSRF header (code "forbidden")',
  '404': 'No such server, queue item, playlist or token (code "not-found")',
  '409': 'Not possible now: nothing is playing, the queue is full (code "conflict")',
  '429': 'Too many failed logins from this address (code "too-many")',
  '503': 'A part jukecord needs is missing: no bot, Discord not answering (code "unavailable")',
};

/** The OpenAPI document. `serverUrl` is where the API is reached (the public address, or a relative one). */
export function openApiDocument(serverUrl = API_PREFIX): Json {
  const components = new Map<string, Json>();
  const paths: Record<string, Json> = {};
  for (const name of OPERATIONS) {
    const spec: OperationSpec = API[name];
    const operation: Json = {
      operationId: name,
      summary: spec.summary,
      tags: [spec.tag],
      'x-jukecord-access': spec.access,
      parameters: parameters(spec, components),
      responses: {
        '200': {
          description: 'Done',
          content: { 'application/json': { schema: referenced(spec.response, components) } },
        },
        ...Object.fromEntries(
          Object.entries(ERRORS).map(([status, description]) => [
            status,
            { description, content: { 'application/json': { schema: referenced(ErrorSchema, components) } } },
          ]),
        ),
      },
    };
    if (spec.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: referenced(spec.body, components) } },
      };
    }
    // The public operation needs no login; the rest take either kind.
    if (spec.access === 'public') operation.security = [];
    paths[spec.path] = { ...(paths[spec.path] ?? {}), [spec.method.toLowerCase()]: operation };
  }
  // The browser endpoints that are not JSON operations, so the document lists everything under the prefix.
  paths['/guilds/{guild}/tracks/{track}/audio'] = {
    get: {
      operationId: 'audio',
      summary:
        'The audio of a track the server is playing or has queued (Ogg Opus, or MP3 for browsers without Opus); supports Range',
      tags: ['browser'],
      parameters: [
        { name: 'guild', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'track', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['opus', 'mp3'] } },
      ],
      responses: {
        '200': { description: 'The audio', content: { 'audio/ogg': {}, 'audio/mpeg': {} } },
        '206': { description: 'Part of the audio (Range)' },
        '404': { description: 'The track is not playing or queued in this server' },
        '409': { description: 'The track is not prepared yet' },
        '503': { description: 'Too many MP3 copies are being made; try again in a moment' },
      },
    },
  };
  // The pictures jukecord fetches once and keeps (src/media/covers.ts), in the formats it keeps.
  const picture = {
    description: 'The picture',
    content: { 'image/jpeg': {}, 'image/png': {}, 'image/gif': {}, 'image/webp': {}, 'image/avif': {} },
  };
  const pictureLater = {
    '429': { description: 'Too many pictures to fetch at once for this login or address; try again after Retry-After' },
    '503': { description: 'jukecord is busy; try again after Retry-After' },
  };
  paths['/guilds/{guild}/tracks/{track}/cover'] = {
    get: {
      operationId: 'cover',
      summary: "A track's cover, fetched once by jukecord and kept, for a track the server shows",
      tags: ['browser'],
      parameters: [
        { name: 'guild', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'track', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      ],
      responses: {
        '200': picture,
        '404': { description: 'The track is not in this server, or it has no cover' },
        ...pictureLater,
      },
    },
  };
  paths['/guilds/{guild}/search/cover'] = {
    get: {
      operationId: 'searchCover',
      summary: "The picture of a search's result before it is added, by its address (found in the last half hour)",
      tags: ['browser'],
      parameters: [
        { name: 'guild', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'url', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': picture,
        '403': { description: 'This login may not search here' },
        '404': { description: 'No search found the address lately, or it has no picture' },
        ...pictureLater,
      },
    },
  };
  paths['/events'] = {
    get: {
      operationId: 'events',
      summary: 'Live updates over WebSocket (see docs/API.md for the messages)',
      tags: ['browser'],
      parameters: [{ name: 'guild', in: 'query', required: false, schema: { type: 'string' } }],
      responses: { '101': { description: 'Switching to WebSocket' } },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'jukecord',
      version: VERSION,
      description: 'Everything the panel does, for programs. Log in with an API token (Authorization: Bearer jkc_...).',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: serverUrl }],
    // Either a token in the Authorization header or the panel's session cookie (with its CSRF header for changes).
    security: [{ token: [] }, { session: [] }],
    paths,
    components: {
      schemas: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))),
      securitySchemes: {
        token: { type: 'http', scheme: 'bearer', description: 'An API token (jukecord token create)' },
        session: { type: 'apiKey', in: 'cookie', name: 'jukecord_session', description: 'The panel login' },
      },
    },
  };
}

/** The operations of one tag, for the API document's sections. */
export function operationsByTag(): Map<string, OperationName[]> {
  const tags = new Map<string, OperationName[]>();
  for (const name of OPERATIONS) tags.set(API[name].tag, [...(tags.get(API[name].tag) ?? []), name]);
  return tags;
}
