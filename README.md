# npm-package-lock-add-resolved

This is a simple npm tool to fill missing `resolved` and `integrity` fields
in npm `package-lock.json` files.

It would seem that these fields can be omitted by npm
when it is able to use locally cached versions of dependencies
but does not have information available regarding origin.

Some discussion surrounding the absence of these fields can be found at
https://github.com/npm/cli/issues/4460

Implementation for this tool was derived from
https://github.com/jeslie0/npm-lockfile-fix

## Usage

```
npx npm-package-lock-add-resolved
```

If you want to use a Docker container instead:

```
docker run --rm -it -v $(pwd):/w --workdir /w node npx npm-package-lock-add-resolved
```
