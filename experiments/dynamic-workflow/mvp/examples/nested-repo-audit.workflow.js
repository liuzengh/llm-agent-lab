export const meta = {
  name: 'nested-repo-audit',
  description: 'Audit repository files and delegate finding verification to a saved child workflow.',
}

phase('Discovery')
const discovery = await agent('You must call list_files before answering. Return up to 8 source file paths relevant to a security audit as JSON with a files array. Do not return an empty array when source files exist.', {
  label: 'discover-files',
  schema: {
    type: 'object',
    required: ['files'],
    additionalProperties: false,
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
})
log(`Discovered ${discovery.files.length} files`)

phase('Audit')
const audits = await pipeline(discovery.files.slice(0, 8), file =>
  agent(`Read ${file} directly with read_file, then audit that file. Only inspect a directly imported helper when necessary. Do not scan unrelated files. Return concrete security findings as JSON.`, {
    label: `audit:${file}`,
    maxTurns: 12,
    schema: {
      type: 'object',
      required: ['path', 'findings'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['severity', 'title', 'evidence'],
            additionalProperties: false,
            properties: {
              severity: { type: 'string' },
              title: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    },
  }),
)

const risky = audits.flatMap(audit =>
  audit.findings
    .filter(finding => ['high', 'critical'].includes(String(finding.severity).toLowerCase()))
    .map(finding => ({ path: audit.path, finding })),
)

phase('Saved workflow verification')
log(`Delegating ${Math.min(risky.length, 6)} findings to verify-finding`)
const verified = await pipeline(
  risky.slice(0, 6),
  item => workflow('verify-finding', item),
)

return {
  summary: `Audited ${audits.length} files and verified ${verified.length} findings with a saved workflow.`,
  audits,
  verified,
}
