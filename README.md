# branch-reviewer-sdk

Branch review agent built on the Claude Agent SDK, running on subscription
credit. Fresh-start successor to
[branch-reviewer-api](https://github.com/racoonamatatas/branch-reviewer-api),
which hand-rolls the same agent loop against the raw Messages API — kept as
the learning artifact and comparison baseline.

Read-and-report only: reviews a GitHub branch against its merge base and
reports structured findings. No editing, no fixing.
