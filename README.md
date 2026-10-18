# TireTrail

![TireTrail on a laptop](docs/images/laptop.png)

TireTrail is a driving coach for Washington. It tells you when you brake hard and shows what your driving costs in gas and tires. It also shows where the tire dust from your street goes when it rains.

It's a web app, so it runs in a phone's browser. You can add it to your home screen.

## Why

Every hard stop grinds a little rubber off your tires. The dust sits on the road until it rains. Then the rain washes it into storm drains, and some of those drains empty right into creeks.

Tire dust carries a chemical called 6PPD-quinone. It can kill coho salmon within hours of a storm. Researchers in Washington traced the die-offs in city streams back to it in 2020.

Gentler stops leave less dust on the road. They save gas and tires too.

## What it does

<p>
  <img src="docs/images/home.png" width="160" alt="Home screen">
  <img src="docs/images/drive.png" width="160" alt="Recording a drive">
  <img src="docs/images/report.png" width="160" alt="Drive report">
  <img src="docs/images/map.png" width="160" alt="Where a street's rain goes">
  <img src="docs/images/drives.png" width="160" alt="My drives">
</p>

Put your phone in a mount and start a drive. TireTrail watches your speed and the phone's motion sensor. When you brake hard, it says so. It learns the places where you often brake hard, and next time it warns you before you get there.

After the drive you get a smooth score and one thing to fix, at a real place. You see what smoother driving could save in a year, and which of your hard brakes drain toward a salmon stream.

The map answers one question for any traced street: where does the rain go? It follows the real pipes and ditches from the storm drain to the water they reach. Where a pipe map has a gap, it says so instead of guessing.

Sign in with Google to keep your progress on a new phone. Full routes stay on your phone either way.

There's also a weekly goal, a share card for each drive, and a button that writes your city a note about your worst hard-brake spots.

## How it's built

TypeScript and Vite, with no server of its own. The app is static files on Vercel. Firebase handles sign-in and backups.

The storm drain tracer runs at build time. It reads city and county pipe maps, connects each inlet to the pipes, ditches and outfalls downstream of it, and follows the water to where it comes out. The results ship as compact files the phone can keep offline.

Drives are analyzed on the phone. GPS speed covers the whole drive. The motion sensor catches short, sharp brakes that phone GPS smooths over. The live coach and the drive report use the same detection code, so they agree.

The map is a custom canvas renderer in a pixel style, drawn from OpenStreetMap roads and Microsoft building outlines.

## Running it

You need Node 22.18 or newer.

```sh
npm install
npm run dev      # the app, locally
npm test         # unit tests
npm run build    # production build in dist/
```

The data scripts (`npm run build:data` and the other `build:*` scripts) rebuild the traced data. Some of them download large source files first.

## Data

Storm drains come from City of Bonney Lake and Pierce County GIS. Coho streams come from WDFW. Streams and lakes come from the USGS National Hydrography Dataset. Roads come from OpenStreetMap contributors, and buildings from Microsoft. The About page in the app lists every source.

TireTrail is an independent student project. No agency named here made or endorsed it. Its numbers are planning-level estimates.

## License

Copyright 2026 Ashwath Polali. All rights reserved. See [LICENSE](LICENSE).
