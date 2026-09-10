-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos AI LLC
--
-- cap-10 · Human decisions through the same gate.
--
-- A caseworker decides the way an agent does: by naming a committed rule and
-- attaching facts, and letting the evaluator say what follows. There is no
-- field for the outcome, because the outcome is not an input. What a human
-- path needs that an agent path did not is for the KIND of determination —
-- refusal, grant, record — to be fixed by the rule rather than chosen at the
-- keyboard; otherwise "disposition" is an outcome field wearing a hat.
--
-- So a registered rule may carry its disposition. Null keeps every existing
-- rule as it was; set, it binds every seal made under the rule, and the
-- caseworker path requires it.
ALTER TABLE rules ADD COLUMN disposition TEXT
  CHECK (disposition IS NULL OR disposition IN ('bind', 'permit', 'commit'));
