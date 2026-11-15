# Flight realism implementation plan

Goal: make fold experiments repeatable and their consequences physically plausible while retaining the shared rigid-body simulation.

Design: retain panel forces and the 1 ms timestep. Subtract coplanar overlapping polygons for aerodynamic area only, preserving every layer's mass and rendering. Blend a finite-wing lift/drag approximation into separated plate flow; account for aerodynamic pressure location. Add persistent left/right tail trim, defaulting to zero for old designs. Sweep hull sample points against city boxes and apply impulses at contacts. Add a still-air workshop trial, run in a worker, with fixed launch conditions and previous-result comparison.

Alternatives: full fluid simulation and flexible paper are too costly for this game. Fixed per-design performance scores would remove the causal relationship between folds and flight. Coefficients here are game approximations, not experimental validation of paper aerodynamics.

- [x] Exposed surfaces and trim: shared/surfaces.js, shared/plane.js, shared/plane.test.js. Verify folded-back area, mass conservation, asymmetric response and compatibility with old designs.
- [x] Aerodynamics: shared/aerodynamics.js and plane dynamics. Verify lift direction, stall transition, span-dependent drag, dissipative forces and existing glide/steering behaviours.
- [x] Contacts: shared/contact.js and shared/flight.js. Verify swept wall, roof and ground contacts, wingtip torque and no impulses when separating.
- [x] Repeatable trials: shared/trial.js, public/trial-worker.js and workshop controls. Fixed 7 m/s level launch from 10 m, still air, no steering, capped at 30 s. Report landing/time-limit outcome, distance, time, lateral displacement and attitude variation. Compare successive trials and label edits since a trial.
- [x] Verification: full bun test suite, JS parsing/build, serving checks, review changes for numerical instability, folded extremes and prediction parity. Preserve unrelated edits. No remote is configured; do not publish or commit unrelated work.

Validation: 27 tests pass across 6 files. Browser entry points and server bundle successfully with Bun. Static worker and shared module endpoints return successfully. The preview passes HTTP doctor checks after restart. No browser UI check was performed. Aerodynamic constants remain game approximations; contact uses swept hull sample points and overlap removal covers coplanar layers.
