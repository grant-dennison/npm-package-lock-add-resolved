# npm-package-lock-add-resolved

This is a simple npm tool to fill missing `resolved` and `integrity` fields
in npm `package-lock.json` files.
Some discussion surrounding the absence of these fields can be found at
https://github.com/npm/cli/issues/4460

Implementation for this tool was derived from
https://github.com/jeslie0/npm-lockfile-fix
