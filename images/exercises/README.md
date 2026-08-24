# Exercise artwork

Drop image files here and point at them from `js/workouts.js`:

```js
image: 'images/exercises/back-squat.svg'
```

Keep the path **relative** — no leading slash. The app is served from a GitHub Pages
subpath (`/mycounter/`), where `/images/...` would resolve to the domain root and 404.

Cards render fine with `image: null`, so artwork can be added one exercise at a time.
Anything the browser displays works; SVG line art stays sharp and stays small.
