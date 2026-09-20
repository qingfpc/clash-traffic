import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessLookup, parsePidToName, parsePortToPid } from '../src/process-lookup.js';
import { resolveProcessAttribution } from '../src/collector.js';

test('Windows 端口快照可按协议和本地端口定位 PID', () => {
  const ports = parsePortToPid([
    '  TCP    127.0.0.1:50121     127.0.0.1:7897      ESTABLISHED     101',
    '  UDP    0.0.0.0:5353        *:*                                  202',
    '  TCP    [::1]:50122         [::1]:7897           ESTABLISHED     303'
  ].join('\r\n'));

  assert.equal(ports.get('TCP:50121'), 101);
  assert.equal(ports.get('UDP:5353'), 202);
  assert.equal(ports.get('TCP:50122'), 303);
});

test('端口查询仅返回同协议端口对应的进程名', () => {
  const ports = parsePortToPid('  TCP    127.0.0.1:50121     127.0.0.1:7897      ESTABLISHED     101');
  const names = parsePidToName('"chrome.exe","101","Console","1","12,000 K"');
  const lookup = createProcessLookup(ports, names);

  assert.equal(lookup('tcp', 50121), 'chrome.exe');
  assert.equal(lookup('udp', 50121), '');
  assert.equal(lookup('tcp', 50122), '');
});

test('进程归属优先使用 Mihomo 字段，再复用连接缓存', () => {
  const connection = { metadata: { network: 'tcp', sourcePort: 50121 } };
  const lookup = () => 'chrome.exe';

  assert.deepEqual(
    resolveProcessAttribution({ metadata: { processPath: 'C:\\Program Files\\app.exe' } }, lookup),
    { name: 'app.exe', source: 'mihomo' }
  );
  assert.deepEqual(
    resolveProcessAttribution(connection, lookup),
    { name: 'chrome.exe', source: 'windows-port' }
  );
  assert.deepEqual(
    resolveProcessAttribution(connection, () => '', { name: 'chrome.exe', source: 'windows-port' }),
    { name: 'chrome.exe', source: 'windows-port' }
  );
  assert.deepEqual(
    resolveProcessAttribution(connection, () => ''),
    { name: '(未归属)', source: 'unresolved' }
  );
});
