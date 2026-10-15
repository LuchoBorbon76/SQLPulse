import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySqlEndpoint } from '../sql-endpoint.js';

test('Managed Instance public endpoints and VNet endpoints never require a user database', () => {
  for (const endpoint of [
    'demo.public.zone.database.windows.net,3342',
    'tcp:demo.public.zone.database.windows.net,3342',
    'demo.zone.database.windows.net',
    'demo.zone.privatelink.database.windows.net,1433',
    'tcp: demo.zone.database.windows.net , 1433',
  ]) {
    const result = classifySqlEndpoint(endpoint);
    assert.equal(result.kind, 'azure-mi');
    assert.equal(result.requiresDatabase, false);
  }
  assert.equal(classifySqlEndpoint('tcp:DEMO.public.zone.database.windows.net,3342').port, 3342);
});

test('Azure SQL Database remains database-scoped including private link', () => {
  for (const endpoint of ['demo.database.windows.net', 'tcp:demo.database.windows.net,1433', 'demo.privatelink.database.windows.net']) {
    assert.equal(classifySqlEndpoint(endpoint).requiresDatabase, true);
  }
});

test('explicit target types support custom aliases and engine probing is authoritative', () => {
  assert.equal(classifySqlEndpoint('mi.contoso.internal', 'azure-mi').kind, 'azure-mi');
  assert.equal(classifySqlEndpoint('db.contoso.internal', 'azure-sqldb').requiresDatabase, true);
  assert.equal(classifySqlEndpoint('alias', 'azure-sqldb', 8).requiresDatabase, false);
  assert.equal(classifySqlEndpoint('alias', 'azure-mi', 5).requiresDatabase, true);
  assert.equal(classifySqlEndpoint('HOST\\INSTANCE', 'auto', 3).kind, 'sql-server');
  assert.equal(classifySqlEndpoint('localhost,1433').kind, 'sql-server');
  assert.throws(() => classifySqlEndpoint('host', 'invalid'), /Invalid/);
});
