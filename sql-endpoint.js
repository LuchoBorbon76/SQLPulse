const TYPES = new Set(['auto', 'sql-server', 'azure-sqldb', 'azure-mi']);

export function classifySqlEndpoint(server, connectionType = 'auto', engineEdition) {
  if (!TYPES.has(connectionType)) throw new Error('Invalid SQL connection type.');
  const address = String(server || '').trim().replace(/^tcp:\s*/i, '').trim();
  const portMatch = address.match(/\s*,\s*(\d+)$/);
  const port = portMatch ? Number(portMatch[1]) : null;
  const host = (portMatch ? address.slice(0, portMatch.index) : address).trim().toLowerCase().replace(/\.$/, '');
  let kind = connectionType === 'auto' ? 'sql-server' : connectionType;
  if (connectionType === 'auto' && /\.database\.windows\.net$/i.test(host)) {
    const prefix = host.slice(0, -'.database.windows.net'.length).replace(/\.privatelink$/, '');
    kind = prefix.includes('.') ? 'azure-mi' : 'azure-sqldb';
  }
  if (Number(engineEdition) === 5) kind = 'azure-sqldb';
  else if (Number(engineEdition) === 8) kind = 'azure-mi';
  else if (Number.isInteger(Number(engineEdition)) && Number(engineEdition) > 0) kind = 'sql-server';
  return { kind, host, port, requiresDatabase: kind === 'azure-sqldb', isAzure: kind !== 'sql-server' };
}
