# LSD Project

## Commands
- Build: `npm run build`

## Conventions

### Publish workflow
When the user says "publish", automatically run the full release sequence without asking:
1. `git add -A && git commit -m "<conventional commit message summarizing changes>"`
2. `git push`
3. Bump version in `package.json` (patch by default; minor/major if the user specifies)
4. Update `CHANGELOG.md` with a new version entry summarizing the changes
5. `npm publish` (from the workspace root, or whichever package is being released)
6. `git add -A && git commit -m "chore: release vX.Y.Z"` and `git push` to capture the version bump and changelog
