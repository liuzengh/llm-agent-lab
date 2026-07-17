export const meta = {
  name: 'repo-audit',
  description: 'Discover relevant files, audit them in parallel, verify risky findings, and summarize.',
}

phase('Discovery')
const discovery = await agent(`Find up to 12 source files that are most relevant for a correctness and security audit.
Use list_files and search_text. Return JSON with a files array and a short reason for each file.`, {
  label: 'discover-files',
  schema: {
    type: 'object',
    required: ['files'],
    additionalProperties: false,
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'reason'],
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
})
log(`Discovered ${discovery.files.length} candidate files`)

phase('Audit')
const audits = await pipeline(discovery.files.slice(0, 12), file =>
  agent(`Audit ${file.path}.
Reason it was selected: ${file.reason}
Read the file before judging it. Return JSON findings. Focus on concrete correctness, security, and reliability risks.`, {
    label: `audit:${file.path}`,
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
            required: ['severity', 'title', 'evidence', 'confidence'],
            additionalProperties: false,
            properties: {
              severity: { type: 'string' },
              title: { type: 'string' },
              evidence: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    },
  }),
)
log(`Audited ${audits.length} files`)

const risky = audits.flatMap(audit =>
  audit.findings
    .filter(finding => ['high', 'critical'].includes(String(finding.severity).toLowerCase()))
    .map(finding => ({ path: audit.path, finding })),
)

phase('Verify')
log(`Verifying ${Math.min(risky.length, 8)} high-risk findings`)
const verified = await pipeline(risky.slice(0, 8), item =>
  agent(`Independently verify this finding.
Path: ${item.path}
Finding: ${JSON.stringify(item.finding)}
Read relevant code and return whether the finding is supported, refuted, or uncertain.`, {
    label: `verify:${item.path}`,
    schema: {
      type: 'object',
      required: ['path', 'status', 'rationale'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        status: { type: 'string' },
        rationale: { type: 'string' },
      },
    },
  }),
)
log(`Verified ${verified.length} findings`)

return {
  summary: `Audited ${audits.length} files and verified ${verified.length} risky findings.`,
  findings: audits,
  verified,
  metrics: {
    discoveredFiles: discovery.files.length,
    auditedFiles: audits.length,
    riskyFindings: risky.length,
  },
}
