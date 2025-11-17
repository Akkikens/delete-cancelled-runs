const https = require('https');

const makeRequest = (options) => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve(data);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
};

/**
 * Check if a cancelled run was superseded by a newer run
 */
const isSupersededRun = (cancelledRun, allRuns) => {
  const refKey = cancelledRun.head_branch || cancelledRun.head_sha;

  // Find newer runs on the same branch/ref
  const newerRuns = allRuns.filter(run => {
    if (run.id === cancelledRun.id) return false;
    const runRefKey = run.head_branch || run.head_sha;
    if (runRefKey !== refKey) return false;
    return new Date(run.created_at) > new Date(cancelledRun.created_at);
  });

  // Check if any newer run is successful or in-progress
  const hasNewerSuccessfulRun = newerRuns.some(run =>
    run.conclusion === 'success' ||
    run.status === 'in_progress' ||
    run.status === 'queued'
  );

  return newerRuns.length > 0 && hasNewerSuccessfulRun;
};

(async () => {
  const dryRun = process.env['INPUT_DRY-RUN'] === 'true';

  if (dryRun) {
    console.log('🔍 DRY-RUN MODE: Will only log, not delete');
  }

  const sharedOptions = {
    hostname: 'api.github.com',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${process.env['INPUT_GITHUB-TOKEN']}`,
      'User-Agent': 'node.js',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  };

  // Get workflow ID from workflow file name
  const workflowsResponse = await makeRequest({
    ...sharedOptions,
    method: 'GET',
    path: `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows`,
  });

  const workflows = JSON.parse(workflowsResponse).workflows;
  const workflow = workflows.find(w => w.path.endsWith(process.env['INPUT_WORKFLOW-FILE']));

  if (!workflow) {
    console.error(`Workflow ${process.env['INPUT_WORKFLOW-FILE']} not found`);
    process.exit(1);
  }

  // Get all recent runs to check for superseding runs
  const allRunsResponse = await makeRequest({
    ...sharedOptions,
    method: 'GET',
    path: `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${workflow.id}/runs?per_page=100`,
  });

  const allRuns = JSON.parse(allRunsResponse).workflow_runs;

  // Get cancelled runs
  const cancelledRunsResponse = await makeRequest({
    ...sharedOptions,
    method: 'GET',
    path: `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${workflow.id}/runs?status=cancelled&per_page=100`,
  });

  const cancelledRuns = JSON.parse(cancelledRunsResponse).workflow_runs;
  console.log(`Found ${cancelledRuns.length} cancelled runs`);

  // Filter to only superseded runs
  const supersededRuns = cancelledRuns.filter(run =>
    isSupersededRun(run, allRuns)
  );

  console.log(`Identified ${supersededRuns.length} as superseded (will delete)`);
  console.log(`Keeping ${cancelledRuns.length - supersededRuns.length} cancelled runs (not superseded)`);

  // Limit to max-deletions
  const runsToDelete = supersededRuns.slice(0, parseInt(process.env['INPUT_MAX-DELETIONS'] || '3'));

  // Delete only superseded runs
  await Promise.all(runsToDelete.map(async (run) => {
    if (dryRun) {
      console.log(`[DRY-RUN] Would delete: ${run.html_url}`);
    } else {
      console.log(`Deleting superseded cancelled workflow run: ${run.html_url}`);
      await makeRequest({
        ...sharedOptions,
        method: 'DELETE',
        path: `/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.id}`,
      });
    }
  }));

  console.log(`✨ Cleanup complete: ${runsToDelete.length} superseded run(s) ${dryRun ? 'would be ' : ''}deleted`);
})();
