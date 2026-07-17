export const meta = {
  name: 'verify-finding',
  description: 'Independently verify one repository finding.',
}

phase('Child verification')
log(`Verifying finding for ${args.path}`)

return await agent(`Independently verify this repository finding.
Path: ${args.path}
Finding: ${JSON.stringify(args.finding)}
Read the path directly first. Return whether the finding is supported, refuted, or uncertain.`, {
  label: `verify:${args.path}`,
  maxTurns: 12,
  capabilities: ['workspace.read'],
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
})
