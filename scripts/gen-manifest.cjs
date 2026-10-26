const path = require('path');
const fs = require('fs');
const ROOT = '/home/icy/.openclaw/extensions/qq';
(async () => {
  const { z } = require(path.join(ROOT, 'node_modules', 'zod'));
  let QQConfigSchema;
  try { ({ QQConfigSchema } = require(path.join(ROOT, 'dist/src/config.js'))); }
  catch { ({ QQConfigSchema } = await import(path.join(ROOT, 'dist/src/config.js'))); }
  const schema = z.toJSONSchema(QQConfigSchema, { io: 'output', target: 'draft-07' });
  const src = fs.readFileSync(path.join(ROOT, 'src/channel.ts'), 'utf8');
  const i = src.indexOf('uiHints: {');
  let depth = 0, j = i + 'uiHints: '.length - 1, end = -1;
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) { end = k; break; } } }
  const block = src.slice(i, end);
  const hints = {};
  const re = /(\w+): \{\s*label: "([^"]*)",\s*help: "([^"]*)",\s*\}/g;
  let m; while ((m = re.exec(block))) hints[m[1]] = { label: m[2], help: m[3] };
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'openclaw.plugin.json'), 'utf8'));
  man.channelConfigs.qq.schema = schema;
  man.channelConfigs.qq.uiHints = { ...(man.channelConfigs.qq.uiHints || {}), ...hints };
  fs.writeFileSync(path.join(ROOT, 'openclaw.plugin.json'), JSON.stringify(man, null, 2) + '\n');
  console.log('props:', Object.keys(schema.properties || {}).length, '| hints:', Object.keys(man.channelConfigs.qq.uiHints).length, '| strip:', !!hints.stripTrailingPeriod, '| token:', !!hints.accessToken);
})().catch(e => { console.log('FAIL', e.message.slice(0, 200)); process.exit(1); });
