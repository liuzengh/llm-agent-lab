export const meta = {
  name: 'parallel-review',
  description: 'Run three heterogeneous repository reviews behind one synchronization barrier.',
}

phase('Parallel review')
log('Starting security, correctness, and test reviews')

const [security, correctness, tests] = await parallel([
  () => agent('Review the repository for the highest-impact security risk.', {
    label: 'security-review',
  }),
  () => agent('Review the repository for the highest-impact correctness bug.', {
    label: 'correctness-review',
  }),
  () => agent('Review the repository for the most important missing test.', {
    label: 'test-review',
  }),
])

log('All parallel review branches reached the synchronization barrier')

return {
  security,
  correctness,
  tests,
}
