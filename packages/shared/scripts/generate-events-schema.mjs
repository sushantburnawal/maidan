import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { zodToJsonSchema } = require('zod-to-json-schema');
const { domainEventSchema } = require('../dist/schemas/domain-events.js');

const currentDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(currentDir, '..', 'contracts', 'events.schema.json');

const schema = zodToJsonSchema(domainEventSchema, {
  name: 'DomainEvent',
  target: 'jsonSchema7',
  $refStrategy: 'none'
});

writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
