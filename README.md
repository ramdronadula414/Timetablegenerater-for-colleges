# Smart Timetable Generator

An AI-assisted college timetable generator with light/dark theme support,
built with React, Tailwind CSS, and Vite.

Nothing about the app itself — colors, light/dark mode, the scheduling
engine, validation, layout, or any other feature — was changed for this
packaging pass. This is purely the project scaffolding needed to build and
host it on GitHub Pages.

## Run it locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`)
that builds the site and publishes it automatically.

1. Push this project to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main` (or run the workflow manually from the **Actions** tab).
5. After the workflow finishes, your site is live at:
   - `https://<your-username>.github.io/<repo-name>/` (project page), or
   - `https://<your-username>.github.io/` (if the repo is named
     `<your-username>.github.io`)

The build uses a relative asset path (`base: "./"` in `vite.config.js`), so
it works at either kind of URL without any changes.

### Why the previous attempt 404'd

A GitHub Pages 404 like the one you saw almost always means the repo didn't
contain a built `index.html` at its root (for example, the raw `.jsx`
component file was pushed on its own, with no build step to turn it into a
static site). This project fixes that: the Actions workflow runs `npm run
build`, which compiles everything into a `dist/` folder with a proper
`index.html`, and that's what gets published.

## Notes on two features that depend on the environment

- **Save / load configuration and the theme toggle** originally used
  `window.storage`, an API that only exists inside Claude's artifact
  preview. `src/lib/storagePolyfill.js` installs a drop-in replacement
  backed by the browser's `localStorage`, so these features work exactly
  the same once deployed — no app code needed to change.
- **"Get suggestions" (AI Insight)** calls the Anthropic API directly from
  the browser. That worked inside the Claude artifact sandbox (which
  proxies the request), but a plain static site has no server and no API
  key, so this call will fail once deployed — the app already catches that
  and shows "AI suggestions aren't available right now," so nothing
  breaks. To make this work for real, you'd need a small backend (e.g. a
  serverless function) that holds your Anthropic API key and forwards the
  request; happy to help build that if you want it.

## Project structure

```
├── index.html
├── src/
│   ├── App.jsx              # the timetable generator (unchanged)
│   ├── main.jsx              # React entry point
│   ├── index.css             # Tailwind entry
│   └── lib/storagePolyfill.js
├── .github/workflows/deploy.yml
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```
