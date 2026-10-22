import { z } from 'zod';

type Op = {
  method: string;
  path: string;
  summary: string;
  tag: string;
  permission?: string[];
  auth: string;
  body?: z.ZodType;
  query?: z.ZodType;
};
const ops: Op[] = [];
export const registerOperation = (op: Op) => ops.push(op);

function toJson(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const p = op.path.replace(/:([a-zA-Z_]+)/g, '{$1}');
    paths[p] ??= {};
    const params = Array.from(op.path.matchAll(/:([a-zA-Z_]+)/g)).map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (op.query) {
      const js = toJson(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        params.push({ name, in: 'query', required: (js.required ?? []).includes(name), schema: schema as never });
      }
    }
    paths[p][op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: op.permission?.length ? `Requires permission: ${op.permission.join(' | ')}` : undefined,
      security: op.auth === 'public' ? [] : [{ bearerAuth: [] }],
      parameters: params,
      requestBody: op.body ? { required: true, content: { 'application/json': { schema: toJson(op.body) } } } : undefined,
      responses: { 200: { description: 'OK' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Chili POS API', version: '1.0.0', description: 'Multi-tenant restaurant & bar POS. All amounts are integer cents (KES).' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
