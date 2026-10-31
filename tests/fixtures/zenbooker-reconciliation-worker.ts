import { z } from 'zod/v3';
import { ZenbookerReconciliationStore } from '../../lib/zenbooker-reconciliation-store';
import { safeApiRun } from '../../lib/zenbooker-api-service';
import { readZenbookerCredentialRevision } from '../../lib/zenbooker-api-server';
import { SITE_PROJECT_ID } from '../../lib/runtime-secrets';

interface Env {
  DB: D1Database;
  QA_API_STORE_TOKEN: string;
  QA_API_WORKSPACE: string;
  QA_API_OTHER_WORKSPACE: string;
}

const TOKEN_HEADER = 'x-qa-zenbooker-api-store';
const workspaces = new Set(['zenbooker-api-local-workspace-a', 'zenbooker-api-local-workspace-b']);
const generation = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const requestKey = z.string().uuid();
const pageSchema = z.object({
  schemaStatus: z.enum(['validated', 'unverified']),
  count: z.number().int().min(0).max(101),
  hasMore: z.boolean(),
  nextCursor: z.string().max(200).nullable(),
  fieldTypes: z.record(z.string().max(32), z.string().max(20)).refine(value => Object.keys(value).length <= 32),
  observations: z.array(z.object({
    id: z.string().min(1).max(150).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).max(300),
    visible: z.boolean().nullable(),
  }).strict()).max(100),
}).strict();

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function count(db: D1Database, table: 'zenbooker_api_runs' | 'zenbooker_api_observations', workspace: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).bind(workspace).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function stateRows(db: D1Database, workspace: string) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM app_credential_state WHERE project_id=?').bind(workspace).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.hostname !== '127.0.0.1' || url.pathname !== '/__qa/store' || request.headers.get(TOKEN_HEADER) !== env.QA_API_STORE_TOKEN) return json({ error: 'fixture_unavailable' }, 404);
    if (!workspaces.has(env.QA_API_WORKSPACE) || !workspaces.has(env.QA_API_OTHER_WORKSPACE) || env.QA_API_WORKSPACE === env.QA_API_OTHER_WORKSPACE) return json({ error: 'fixture_unavailable' }, 404);
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > 16_384) return json({ error: 'fixture_unavailable' }, 413);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json({ error: 'fixture_unavailable' }, 400);
    }
    const workspace = body.workspace === 'other' ? env.QA_API_OTHER_WORKSPACE : env.QA_API_WORKSPACE;
    const store = new ZenbookerReconciliationStore(env.DB, workspace, () => Number(body.now ?? Date.now()));
    try {
      switch (body.op) {
        case 'init': {
          for (const projectId of [env.QA_API_WORKSPACE, env.QA_API_OTHER_WORKSPACE]) {
            await env.DB.prepare('INSERT OR IGNORE INTO app_credential_state(project_id,revision,sealed_at,operation_token) VALUES(?,1,NULL,NULL)').bind(projectId).run();
          }
          const [runs, observations] = await Promise.all([
            count(env.DB, 'zenbooker_api_runs', env.QA_API_WORKSPACE),
            count(env.DB, 'zenbooker_api_observations', env.QA_API_WORKSPACE),
          ]);
          return json({ ready: runs === 0 && observations === 0, runs, observations });
        }
        case 'start': {
          const key = requestKey.parse(body.requestKey);
          const resource = z.enum(['services', 'jobs', 'check']).parse(body.resource);
          const kind = body.kind === undefined ? undefined : z.enum(['check', 'refresh']).parse(body.kind);
          const gen = generation.parse(body.generation);
          const revision = z.number().int().positive().parse(body.credentialRevision);
          const window = body.window === undefined ? undefined : z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict().parse(body.window);
          const run = await store.start({ requestKey: key, resource, ...(kind ? { kind } : {}), ...(window ? { window } : {}), generation: gen, credentialRevision: revision });
          return json({ run: safeApiRun(run) });
        }
        case 'claim': {
          const result = await store.claim(z.string().uuid().parse(body.runId), z.number().int().positive().parse(body.expectedRevision), requestKey.parse(body.requestKey), generation.parse(body.generation));
          return json({ claimed: result.claimed, run: safeApiRun(result.run) });
        }
        case 'commit': {
          const page = pageSchema.parse(body.page);
          const run = await store.commit(z.string().uuid().parse(body.runId), z.number().int().positive().parse(body.claimRevision), requestKey.parse(body.requestKey), generation.parse(body.generation), page);
          return json({ run: safeApiRun(run) });
        }
        case 'fail': {
          const diagnostics = body.diagnostics === undefined ? undefined : z.record(z.unknown()).parse(body.diagnostics);
          const run = await store.fail(z.string().uuid().parse(body.runId), z.number().int().positive().parse(body.claimRevision), requestKey.parse(body.requestKey), generation.parse(body.generation), z.string().min(1).max(40).parse(body.errorCode), diagnostics);
          return json({ run: safeApiRun(run) });
        }
        case 'finishCheck': {
          const diagnostics = z.record(z.unknown()).parse(body.diagnostics);
          const run = await store.finishCheck(z.string().uuid().parse(body.runId), z.number().int().positive().parse(body.claimRevision), requestKey.parse(body.requestKey), generation.parse(body.generation), diagnostics);
          return json({ run: safeApiRun(run) });
        }
        case 'get': {
          const run = await store.get(z.string().uuid().parse(body.runId));
          return json({ run: safeApiRun(run) });
        }
        case 'status': {
          return json(await store.status(generation.parse(body.generation)));
        }
        case 'rotate': {
          const target = body.workspace === 'other' ? env.QA_API_OTHER_WORKSPACE : env.QA_API_WORKSPACE;
          const nextRevision = z.number().int().positive().parse(body.revision);
          const result = await env.DB.prepare('UPDATE app_credential_state SET revision=? WHERE project_id=?').bind(nextRevision, target).run();
          return json({ changed: Number(result.meta.changes) === 1 });
        }
        case 'missingCredentialRevision': {
          const before = await stateRows(env.DB, SITE_PROJECT_ID);
          const store = { statement: (sql: string, ...bindings: unknown[]) => env.DB.prepare(sql).bind(...bindings) };
          const revision = await readZenbookerCredentialRevision(store as never);
          const after = await stateRows(env.DB, SITE_PROJECT_ID);
          return json({ revision, before, after });
        }
        case 'inspect': {
          const selectedWorkspace = body.workspace === 'other' ? env.QA_API_OTHER_WORKSPACE : env.QA_API_WORKSPACE;
          const otherWorkspace = selectedWorkspace === env.QA_API_WORKSPACE ? env.QA_API_OTHER_WORKSPACE : env.QA_API_WORKSPACE;
          const [runs, observations, otherRuns, otherObservations] = await Promise.all([
            count(env.DB, 'zenbooker_api_runs', selectedWorkspace),
            count(env.DB, 'zenbooker_api_observations', selectedWorkspace),
            count(env.DB, 'zenbooker_api_runs', otherWorkspace),
            count(env.DB, 'zenbooker_api_observations', otherWorkspace),
          ]);
          const [tables, leakedValues, invalidShape, domainRows] = await Promise.all([
            env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('appointments','customers','inquiries','hosted_booking_references')").all<{ name: string }>(),
            env.DB.prepare("SELECT COUNT(*) AS count FROM zenbooker_api_observations WHERE workspace_id=? AND (observation_json LIKE '%@%' OR observation_json LIKE '%phone%' OR observation_json LIKE '%price%' OR observation_json LIKE '%amount%')").bind(selectedWorkspace).first<{ count: number }>(),
            env.DB.prepare("SELECT COUNT(*) AS count FROM zenbooker_api_observations o WHERE o.workspace_id=? AND (json_type(o.observation_json,'$.id')!='text' OR json_type(o.observation_json,'$.name')!='text' OR json_type(o.observation_json,'$.visible') NOT IN ('true','false','null') OR (SELECT COUNT(*) FROM json_each(o.observation_json))!=3)").bind(selectedWorkspace).first<{ count: number }>(),
            env.DB.prepare("SELECT 'appointments' AS name,COUNT(*) AS count FROM appointments WHERE workspace_id=? UNION ALL SELECT 'customers',COUNT(*) FROM customers WHERE workspace_id=? UNION ALL SELECT 'inquiries',COUNT(*) FROM inquiries WHERE workspace_id=? UNION ALL SELECT 'hosted_booking_references',COUNT(*) FROM hosted_booking_references WHERE workspace_id=?").bind(selectedWorkspace, selectedWorkspace, selectedWorkspace, selectedWorkspace).all<{ name: string; count: number }>(),
          ]);
          return json({
            runs, observations, otherRuns, otherObservations,
            unrelatedDomainTables: (tables.results ?? []).map(row => row.name).sort(),
            sensitiveObservationMatches: Number(leakedValues?.count ?? 0),
            nonAllowlistedObservationCount: Number(invalidShape?.count ?? 0),
            unrelatedDomainRowCounts: domainRows.results ?? [],
          });
        }
        default:
          return json({ error: 'fixture_unavailable' }, 404);
      }
    } catch {
      return json({ error: 'fixture_operation_failed' }, 500);
    }
  },
};
