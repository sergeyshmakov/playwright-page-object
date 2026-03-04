# Contributing to `playwright-page-object`

First off, thank you for being here! 🎉 

I'm a solo maintainer working on this project in my free time, and I am thrilled that you want to help make it better. To keep things moving smoothly and respect everyone's time, I just have a few simple guidelines.

## 💡 The Golden Rule: Let's talk first!

**Bugs & Typos:** Did you find a bug, a typo, or something broken? Feel free to open a Pull Request directly! No need to ask.

**New Features & Big Changes:** Before you spend your valuable time writing code for a new feature, **please open an Issue first to discuss it.** 
Why? Because I want to make sure your idea fits the vision of the project, doesn't duplicate ongoing work, and uses an architecture we agree on. I would hate to reject a massive PR that you spent hours on just because we didn't chat first!

## 🛠️ Local Development

Setting up the project is super simple. We don't have a massive web of tools—just install and build!

1. **Fork & Clone** the repository.
2. **Install dependencies:**
   ```bash
   npm ci
   ```
3. **Run the dev watcher:**
   ```bash
   npm run dev
   ```
   *This uses `tsup` to instantly rebuild the MCP server whenever you save a file.*

## 🎨 Code Style (Zero Config!)

You don't need to configure your editor, set up ESLint, or worry about formatting rules. We use **Biome**.

Just write your code naturally. When you are ready to commit, our Husky pre-commit hook will automatically format your files and fix any basic linting errors in milliseconds. 

If you want to run it manually before committing:
```bash
npm run lint:fix
```

## 📦 Committing & Publishing

We use automated releases, which means your commit messages dictate the version numbers and the changelog. 

When you run `git commit`, you must use **Conventional Commits**:
* `feat: added a new tool` (Triggers a Minor release, e.g., 1.1.0)
* `fix: resolved crash on startup` (Triggers a Patch release, e.g., 1.0.1)
* `docs: updated readme` (No release triggered)

*(Don't worry, if you format it wrong, the terminal will kindly reject the commit and ask you to fix it!)*

Once your PR is merged into `main`, GitHub Actions will automatically compile the code, write the release notes, and publish the new version to NPM. You don't need to bump any version numbers in `package.json`.
