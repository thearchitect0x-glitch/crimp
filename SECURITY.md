# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/thearchitect0x-glitch/crimp/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

**You will hear back within 72 hours**, and a first assessment within 7 days.
If you do not, escalate through the contact on the project homepage.

## Credit

Reporters are credited by name or handle in the advisory and the release notes,
unless they ask not to be. If you would like to be credited differently, say so
in the report.

## What is in scope

- The grammar and evaluator: any input that makes evaluation non-terminating,
  non-deterministic, or type-confused.
- Any path that lets a caller seal a determination without meeting the declared
  authority requirement, or reverse one without meeting the claw rule.
- Any cross-tenant read or write.
- Any path that recovers a raw subject value from a stored blinded identifier.

## Properties the test suite does not enforce

Stated because a reader is entitled to know which guarantees are checked and
which are only intended.

- **Constant-time key comparison.** `verifyKey` runs the MAC comparison even
  for an unknown prefix, and a mutation that replaces `timingSafeEqual` with
  `===` passes the whole suite. A timing assertion sensitive enough to catch it
  would be flaky, and a flaky security test is worse than a documented gap. The
  testable precondition IS enforced: `DECOY_MAC` must match a real MAC in
  length, or the length guard short-circuits and the comparison is skipped
  entirely. Review changes to that function by reading them.

## What is not

- The attestation trust root. Crimp holds no credentials and never reaches into
  a customer's systems, so a customer that attests false facts can produce a
  valid proof of a wrong decision. This is a documented, permanent limitation
  and not a vulnerability. See the assurance case.
- Denial of service by a workspace against its own quota.
