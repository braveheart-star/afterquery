# mutkit 0.1.4

Build a Prometheus task (tests added to a real repository) or a Titan task
(a test suite written from a specification) on your own machine, check it
end to end the way the verifier runs it, and pack it for the task page.

Needs Node.js 20+ and Docker. Every check runs with the network off and
the lane's verifier envelope:

- Prometheus: 8 CPUs, 16 GB, the verifier stops at 90 minutes; at least 20 mutants (no maximum)
- Titan: 4 CPUs, 8 GB, the verifier stops at 60 minutes; at least 50 mutants, 60 or more recommended (no maximum)

Create the task on the task page first (New task). The platform writes the
task's own task.toml (its repository, base commit, image and envelope) and
its environment; the task.toml mutkit scaffolds holds only the fields you
fill in, which the upload carries into it. Replace every <<EDIT-ME>>.

## Commands

`mutkit scaffold tasks/<name> --lane prometheus|titan --lang <language> [--program rust|go|c|cpp|python|node|java --program-name <bin>]`

Start a task folder: the instruction, task.toml, the agent image, the reference tests, the verifier files and a scoring.toml whose run_tests writes JUnit for your language (python, go, rust, java-maven, java-gradle, typescript-jest, typescript-vitest, cpp).

`mutkit check tasks/<name> [--repo <working copy> [--ref <commit>]] [--static] [--no-leakage] [--native]`

Static checks, then the task end to end in Docker with the network off: reference and empty through the scorer, the kill matrix, what the repository already kills and the clean-removal check (Prometheus), timings against the lane's verifier limit, the task.toml fields the submit reads, and the leakage scan.

`mutkit baseline tasks/<name> --repo <working copy> [--ref <commit>] [--native]`

Prometheus: record the repository's own test files and test ids inside the agent's image into tests/mutation/baseline.json, so they never earn credit.

`mutkit leakage tasks/<name> [--repo <working copy> [--ref <commit>]] [--native]`

Scan the agent's image for a .git history, the program's source or binaries, mutants, hidden folders and reference test names.

`mutkit pack tasks/<name> [--out <file.zip>]`

Run the static checks and zip the task folder with a manifest for the task page. Run check first: its summary goes in the zip.

`mutkit rules`

The numbers every check uses. Ranges, not targets.

## A typical run

Prometheus:

    ./mutkit scaffold tasks/my-task --lane prometheus --lang python
    # write the ticket (instruction.md) and declare its 3 to 5 scenarios in
    # task.toml [[scenarios]]; write the removal patch, the reference tests
    # (solution/files/), the mutants (tests/mutants/<scenario id>-<n>.patch,
    # e.g. parse-errors-1) and their reference copies
    ./mutkit baseline tasks/my-task --repo ~/src/repo --ref <base commit>
    ./mutkit check tasks/my-task --repo ~/src/repo --ref <base commit>
    ./mutkit pack tasks/my-task

Titan:

    ./mutkit scaffold tasks/my-tool --lane titan --lang python --program rust --program-name my-tool
    # unzip the program you claimed (Download program on its claim) into
    # tests/program/: for local checks; the platform builds the copy it
    # holds on record. Write the spec in instruction.md with a REQ id on
    # every requirement, and each mutant as
    # tests/program/mutants/REQ-<section>.<n>-<k>.patch (e.g. REQ-3.2-1)
    ./mutkit check tasks/my-tool
    ./mutkit pack tasks/my-tool

## What check reports

- the kill matrix: every mutant, how many reference tests kill it and how
  long it took; a mutant the reference tests do not kill is an error
- an empty submission must score 0
- Prometheus: mutants the repository's own tests already kill (a copied
  test would earn them), and the clean-removal check: the remaining suite
  passes without the removed tests, and nothing left names them
- the reference run's time against the verifier's limit
- Titan: warnings where the spec misses the bar a tester is held to
  (every byte and exit status a reference test asserts follows from a
  numbered requirement): no requirement states the exit status of a
  successful run while the tests check statuses, or lines worded as rules
  ("must", "always", "is ignored") carry no REQ id
- timeout_sec and build_timeout_sec against the reference run and a build
  scaled to one CPU (see below)
- the leakage scan of the agent's image: no .git, no program source or
  binary, no mutants, no reference test names

On an arm machine add --native to build for your own architecture (amd64
runs emulated otherwise); timings then read lower than the platform's.

## Timeouts and CPUs

check runs with the lane's full CPU envelope, but on the platform a
verifier gets roughly 1 to 1.5 CPUs: its trials share a machine. A build
or a test run that takes 10 seconds here on 8 CPUs can take over a minute
there. Size timeout_sec and build_timeout_sec for that. check measures the
CPU time the reference run and a build use, scales them to one CPU, and
warns when a limit is under 2 times that. A reference run cut short at
either limit is not graded, and the task scores 0.
