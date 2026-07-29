# Union equality narrowing

Literal equality narrowing must normalize both operand order and comparison
polarity before it updates a scope. Treating only the left operand as the
subject left `"ok" === result.kind` unnarrowed, while applying the ordinary
truthy rule to `!==` selected the excluded branch. The shared narrowing helper
now returns the checked expression, literal type, and whether a truthy outcome
means a match. Symbol and stable member-expression narrowings consume that
same information, so discriminated object access works for reversed equality
and inequality without separate property-access exceptions.
