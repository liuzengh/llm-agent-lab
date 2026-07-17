export const meta = {
  name: 'pipeline-streaming',
  description: 'Stream each file through audit and verification stages without a stage-wide barrier.',
}

phase('Streaming audit pipeline')
log('Each file advances to verification as soon as its own audit completes')

const results = await pipeline(
  ['src/auth.ts', 'src/routes.ts'],
  file => agent(`Read and audit ${file}. Return one concise finding or "none".`, {
    label: `audit:${file}`,
  }),
  audit => agent(`Independently verify this audit result: ${audit}`, {
    label: 'verify-audit',
  }),
)

log(`Pipeline completed ${results.length} items`)
return results
