import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const GRAVITY = -14;
// Bounciness x1.5; capped at 0.95 so bounces don't gain energy and grow forever.
const RESTITUTION = Math.min(0.62 * 1.5, 0.95);
const WALL_RESTITUTION = Math.min(0.7 * 1.5, 0.95);
const BALL_RESTITUTION = 0.85;
const BALL_RADIUS = 0.6;
const FLOOR_Y = 0;
const MOVE_SPEED = 6;

// Walled play area: balls (and the camera) can never leave the floor.
const ARENA_HALF = 12;
const WALL_HEIGHT = 12;
const CAMERA_MARGIN = 0.4;

// Ball-vs-camera collision: the camera acts like an immovable ball of this
// radius. On impact it gets a quick positional kick (no tilt) in the
// direction the ball was heading, which springs back to upright fast.
const CAMERA_HIT_RADIUS = 1.1;
const CAMERA_KICK_SCALE = 0.045;
const CAMERA_KICK_MAX = 0.6;
const CAMERA_KICK_DECAY = 10; // higher = snaps back faster

// Kick force doubled.
const KICK_SPEED = 9 * 2;
const KICK_UP_SPEED = 6 * 2;

// Wall-mounted add button geometry/animation tuning.
const BUTTON_RADIUS = 0.85;
const BUTTON_DEPTH = 0.4;
const BUTTON_PRESS_DEPTH = 0.22;
const BUTTON_PRESS_DURATION = 0.32;

export class BallScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this._onAddRequested = options.onAddRequested ?? null;
    this.balls = [];
    this._running = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfe8ff);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 3.5, 9);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Bright ambient fill plus a single subtle sun light casting basic shadows.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
    sun.position.set(8, 16, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 40;
    sun.shadow.camera.left = -ARENA_HALF;
    sun.shadow.camera.right = ARENA_HALF;
    sun.shadow.camera.top = ARENA_HALF;
    sun.shadow.camera.bottom = -ARENA_HALF;
    sun.shadow.bias = -0.001;
    this.scene.add(sun);
    this.sun = sun;

    // A second, softer overhead light hanging at the center of the ceiling.
    const ceilingLight = new THREE.PointLight(0xfff4e0, 300, ARENA_HALF * 4, 1.5);
    ceilingLight.position.set(0, WALL_HEIGHT - 0.5, 0);
    ceilingLight.castShadow = true;
    ceilingLight.shadow.mapSize.set(1024, 1024);
    ceilingLight.shadow.camera.near = 0.5;
    ceilingLight.shadow.camera.far = WALL_HEIGHT + 5;
    ceilingLight.shadow.bias = -0.001;
    this.scene.add(ceilingLight);
    this.ceilingLight = ceilingLight;

    const arenaSize = ARENA_HALF * 2;

    const floorGeo = new THREE.PlaneGeometry(arenaSize, arenaSize);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x9ad17b, roughness: 1 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(arenaSize, ARENA_HALF, 0x4c8f3c, 0x6fae57);
    grid.position.y = FLOOR_Y + 0.01;
    this.scene.add(grid);

    this._buildWalls(arenaSize);
    this._buildAddButton();

    // ---- Fly controls: PointerLockControls for mouse-look + WASD movement ----
    this.controls = new PointerLockControls(this.camera, canvas);
    this.keys = { w: false, a: false, s: false, d: false };
    this._onKeyDown = (e) => this._setKey(e.code, true);
    this._onKeyUp = (e) => this._setKey(e.code, false);
    this._onCanvasClick = () => this.controls.lock();
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    canvas.addEventListener("click", this._onCanvasClick);

    // ---- Click a ball to bounce it up ----
    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._onPointerDown = (e) => this._handlePointerDown(e);
    canvas.addEventListener("pointerdown", this._onPointerDown);

    this._onResize = () => this._handleResize();
    window.addEventListener("resize", this._onResize);

    // Current visual displacement applied to the camera from ball impacts;
    // decays back to zero every frame (see _animate).
    this._cameraKickOffset = new THREE.Vector3();

    this._clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
  }

  _buildWalls(arenaSize) {
    const wallDefs = [
      { pos: [0, WALL_HEIGHT / 2, -ARENA_HALF], rot: [0, 0, 0], size: [arenaSize, WALL_HEIGHT] },
      { pos: [0, WALL_HEIGHT / 2, ARENA_HALF], rot: [0, Math.PI, 0], size: [arenaSize, WALL_HEIGHT] },
      { pos: [-ARENA_HALF, WALL_HEIGHT / 2, 0], rot: [0, Math.PI / 2, 0], size: [arenaSize, WALL_HEIGHT] },
      { pos: [ARENA_HALF, WALL_HEIGHT / 2, 0], rot: [0, -Math.PI / 2, 0], size: [arenaSize, WALL_HEIGHT] },
      // Ceiling.
      { pos: [0, WALL_HEIGHT, 0], rot: [Math.PI / 2, 0, 0], size: [arenaSize, arenaSize] },
    ];

    this.walls = wallDefs.map((def) => {
      const geo = new THREE.PlaneGeometry(...def.size);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      });
      const wall = new THREE.Mesh(geo, mat);
      wall.position.set(...def.pos);
      wall.rotation.set(...def.rot);
      wall.receiveShadow = true;
      this.scene.add(wall);
      return wall;
    });

    this._buildStadiumLights();
  }

  // One floodlight above the top-center of each of the 4 side walls (not the ceiling),
  // angled down and inward over the arena like stadium floodlights.
  _buildStadiumLights() {
    const wallTopCenters = [
      [0, WALL_HEIGHT, -ARENA_HALF],
      [0, WALL_HEIGHT, ARENA_HALF],
      [-ARENA_HALF, WALL_HEIGHT, 0],
      [ARENA_HALF, WALL_HEIGHT, 0],
    ];

    this.stadiumLights = wallTopCenters.map(([x, y, z]) => {
      const light = new THREE.SpotLight(0xfff8e6, 350, ARENA_HALF * 4, Math.PI / 6, 0.4, 1.5);
      light.position.set(x, y, z);
      light.target.position.set(x * 0.3, FLOOR_Y, z * 0.3);
      light.visible = false; // Stadium lights disabled.
      this.scene.add(light);
      this.scene.add(light.target);
      return light;
    });
  }

  /**
   * A physical, wall-mounted push button (dark recessed housing + a red
   * knob with a painted plus sign) on the far wall facing the spawn point.
   * Clicking/raycasting it pushes the knob into the wall and springs it
   * back out, then fires the onAddRequested callback.
   */
  _buildAddButton() {
    // Top-right corner of the far wall, as seen from the spawn camera
    // (which looks down -z with +x to its right).
    const margin = 2;
    const wallX = ARENA_HALF - margin;
    const wallY = WALL_HEIGHT - margin;
    const wallZ = -ARENA_HALF;

    const group = new THREE.Group();
    group.position.set(wallX, wallY, wallZ + 0.01);
    this.scene.add(group);

    // Recessed dark housing flush against the wall.
    const housingGeo = new THREE.CylinderGeometry(
      BUTTON_RADIUS * 1.25,
      BUTTON_RADIUS * 1.25,
      0.12,
      32
    );
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.3 });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.rotation.x = Math.PI / 2;
    housing.position.z = 0.06;
    housing.castShadow = true;
    housing.receiveShadow = true;
    housing.userData.isAddButton = true;
    group.add(housing);

    // The pressable red knob, sticking out of the housing.
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xd6241a, roughness: 0.4, metalness: 0.1 });
    const capMat = new THREE.MeshStandardMaterial({
      map: this._buildPlusTexture(),
      roughness: 0.45,
      metalness: 0.1,
    });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x8f150d, roughness: 0.6 });
    const knobGeo = new THREE.CylinderGeometry(BUTTON_RADIUS, BUTTON_RADIUS, BUTTON_DEPTH, 32);
    const knob = new THREE.Mesh(knobGeo, [sideMat, capMat, backMat]);
    knob.rotation.x = -Math.PI / 2;
    knob.castShadow = true;
    knob.receiveShadow = true;
    knob.userData.isAddButton = true;
    group.add(knob);

    this.addButton = {
      group,
      knob,
      restZ: BUTTON_DEPTH / 2 + 0.12,
      animT: null, // null = idle, otherwise seconds elapsed since press
    };
    knob.position.z = this.addButton.restZ;
  }

  _buildPlusTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#e8362a";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();

    const thickness = size * 0.22;
    const inset = size * 0.16;
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 6;
    ctx.fillRect((size - thickness) / 2, inset, thickness, size - inset * 2);
    ctx.fillRect(inset, (size - thickness) / 2, size - inset * 2, thickness);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _pressAddButton() {
    if (!this.addButton || this.addButton.animT !== null) return; // ignore clicks mid-animation
    this.addButton.animT = 0;
  }

  _setKey(code, value) {
    switch (code) {
      case "KeyW": this.keys.w = value; break;
      case "KeyA": this.keys.a = value; break;
      case "KeyS": this.keys.s = value; break;
      case "KeyD": this.keys.d = value; break;
    }
  }

  _handleResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _handlePointerDown(event) {
    if (this.controls.isLocked) {
      // While flying, aim is always the crosshair at screen center.
      this._pointer.set(0, 0);
    } else {
      const rect = this.canvas.getBoundingClientRect();
      this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // No far limit: default raycaster.far is Infinity, so distance never matters.
    this.raycaster.setFromCamera(this._pointer, this.camera);
    const meshes = this.balls.map((b) => b.mesh);
    if (this.addButton) meshes.push(this.addButton.knob, this.addButton.group.children[0]);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;

    const hit = hits[0].object;
    if (hit.userData.isAddButton) {
      this._pressAddButton();
      return;
    }
    const ball = this.balls.find((b) => b.mesh === hit);
    if (ball) this._kickBall(ball);
  }

  _kickBall(ball) {
    // Kick the ball away from the camera (horizontally) with an upward pop.
    const dir = new THREE.Vector3().subVectors(ball.mesh.position, this.camera.position);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    ball.velocity.x = dir.x * KICK_SPEED;
    ball.velocity.z = dir.z * KICK_SPEED;
    ball.velocity.y = KICK_UP_SPEED;
  }

  /**
   * Builds a round ball geometry with the face photo projected flat onto the
   * front AND the back hemisphere, instead of wrapped around the whole sphere,
   * so it reads as a face rather than a smeared, pole-pinched texture.
   */
  _buildFaceGeometry() {
    const widthSegments = 32;
    const heightSegments = 32;

    const hemispheres = [0, Math.PI].map((phiStart) => {
      const geo = new THREE.SphereGeometry(
        1,
        widthSegments,
        heightSegments,
        phiStart,
        Math.PI
      );

      // Planar (decal-style) UV projection using each vertex's own x/y,
      // instead of the sphere's default spherical-wrap UVs.
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const u = THREE.MathUtils.clamp(0.5 + pos.getX(i) * 0.5, 0, 1);
        const v = THREE.MathUtils.clamp(0.5 + pos.getY(i) * 0.5, 0, 1);
        uv.setXY(i, u, v);
      }
      uv.needsUpdate = true;
      return geo;
    });

    const geo = mergeGeometries(hemispheres, false);
    geo.scale(BALL_RADIUS, BALL_RADIUS, BALL_RADIUS);
    return geo;
  }

  /**
   * Adds a new bouncing ball wrapped with the given face photo (data URL).
   */
  addFaceBall(photoDataUrl) {
    const loader = new THREE.TextureLoader();
    loader.load(photoDataUrl, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;

      const geo = this._buildFaceGeometry();
      const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, metalness: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const spreadX = (Math.random() - 0.5) * 6;
      const spreadZ = (Math.random() - 0.5) * 6;
      const startHeight = 8 + Math.random() * 3;
      mesh.position.set(spreadX, startHeight, spreadZ);

      // Face the viewer only at the moment it drops in; after that it tumbles like a normal ball.
      mesh.lookAt(this.camera.position);

      this.scene.add(mesh);
      this.balls.push({
        mesh,
        velocity: new THREE.Vector3(0, 0, 0),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2
        ),
      });
    });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._clock.start();
    this.renderer.setAnimationLoop(this._animate);
  }

  stop() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _animate() {
    const dt = Math.min(this._clock.getDelta(), 0.05);

    // Undo last frame's visual kick offset so all physics/movement below
    // works with the camera's true (upright) position.
    this.camera.position.sub(this._cameraKickOffset);

    // Physics: gravity + floor/wall bounce for every ball.
    const wallLimit = ARENA_HALF - BALL_RADIUS;
    for (const ball of this.balls) {
      ball.velocity.y += GRAVITY * dt;
      ball.mesh.position.x += ball.velocity.x * dt;
      ball.mesh.position.y += ball.velocity.y * dt;
      ball.mesh.position.z += ball.velocity.z * dt;

      const floorContact = FLOOR_Y + BALL_RADIUS;
      if (ball.mesh.position.y <= floorContact) {
        ball.mesh.position.y = floorContact;
        if (ball.velocity.y < 0) {
          ball.velocity.y = -ball.velocity.y * RESTITUTION;
          if (Math.abs(ball.velocity.y) < 0.4) ball.velocity.y = 0;
        }
      }

      // Bounce off the arena walls so balls never leave the floor.
      if (ball.mesh.position.x > wallLimit) {
        ball.mesh.position.x = wallLimit;
        ball.velocity.x = -Math.abs(ball.velocity.x) * WALL_RESTITUTION;
      } else if (ball.mesh.position.x < -wallLimit) {
        ball.mesh.position.x = -wallLimit;
        ball.velocity.x = Math.abs(ball.velocity.x) * WALL_RESTITUTION;
      }
      if (ball.mesh.position.z > wallLimit) {
        ball.mesh.position.z = wallLimit;
        ball.velocity.z = -Math.abs(ball.velocity.z) * WALL_RESTITUTION;
      } else if (ball.mesh.position.z < -wallLimit) {
        ball.mesh.position.z = -wallLimit;
        ball.velocity.z = Math.abs(ball.velocity.z) * WALL_RESTITUTION;
      }

      // Regular ball tumble from here on (no longer locked to face the viewer).
      ball.mesh.rotation.x += ball.spin.x * dt;
      ball.mesh.rotation.y += ball.spin.y * dt;
      ball.mesh.rotation.z += ball.spin.z * dt;
    }

    this._resolveBallCollisions();
    this._resolveCameraCollisions();

    // Animate the wall button springing in and back out after a press.
    if (this.addButton && this.addButton.animT !== null) {
      this.addButton.animT += dt;
      const p = Math.min(this.addButton.animT / BUTTON_PRESS_DURATION, 1);
      const depth = BUTTON_PRESS_DEPTH * Math.sin(p * Math.PI);
      this.addButton.knob.position.z = this.addButton.restZ - depth;
      if (p >= 1) {
        this.addButton.knob.position.z = this.addButton.restZ;
        this.addButton.animT = null;
        this._onAddRequested?.();
      }
    }

    // Fly-through movement (only while pointer is locked).
    if (this.controls.isLocked) {
      const speed = MOVE_SPEED * dt;
      if (this.keys.w) this.controls.moveForward(speed);
      if (this.keys.s) this.controls.moveForward(-speed);
      if (this.keys.d) this.controls.moveRight(speed);
      if (this.keys.a) this.controls.moveRight(-speed);
    }

    // Keep the camera inside the arena — it can't pass through walls, floor or ceiling.
    const camLimit = ARENA_HALF - CAMERA_MARGIN;
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -camLimit, camLimit);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -camLimit, camLimit);
    this.camera.position.y = THREE.MathUtils.clamp(
      this.camera.position.y,
      CAMERA_MARGIN,
      WALL_HEIGHT - CAMERA_MARGIN
    );

    // Decay the visual kick offset (quick spring back to upright) and apply
    // it on top of the true camera position for rendering only.
    this._cameraKickOffset.multiplyScalar(Math.exp(-CAMERA_KICK_DECAY * dt));
    if (this._cameraKickOffset.lengthSq() < 1e-6) this._cameraKickOffset.set(0, 0, 0);
    this.camera.position.add(this._cameraKickOffset);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Pairwise sphere collision: pushes overlapping balls apart and exchanges
   * velocity along the collision normal (equal-mass elastic-ish bounce).
   */
  _resolveBallCollisions() {
    const minDist = BALL_RADIUS * 2;
    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const b = balls[j];
        const delta = new THREE.Vector3().subVectors(b.mesh.position, a.mesh.position);
        const dist = delta.length();
        if (dist === 0 || dist >= minDist) continue;

        const normal = delta.divideScalar(dist);
        const overlap = minDist - dist;

        // Separate the balls evenly so they don't sink into each other.
        a.mesh.position.addScaledVector(normal, -overlap / 2);
        b.mesh.position.addScaledVector(normal, overlap / 2);

        // Exchange the velocity component along the normal (equal masses).
        const relVel = new THREE.Vector3().subVectors(b.velocity, a.velocity);
        const sep = relVel.dot(normal);
        if (sep >= 0) continue; // already moving apart

        const impulse = -(1 + BALL_RESTITUTION) * sep / 2;
        a.velocity.addScaledVector(normal, -impulse);
        b.velocity.addScaledVector(normal, impulse);
      }
    }
  }

  /**
   * Balls bounce off the camera like it's an immovable capsule running from
   * the camera down to the floor (i.e. the player's whole body, not just a
   * ball at head height). On impact the camera also gets a quick positional
   * kick (never a tilt) in the direction the ball was heading, sized by how
   * fast it was going; it springs back to upright shortly after (handled by
   * the decay in _animate).
   */
  _resolveCameraCollisions() {
    const minDist = BALL_RADIUS + CAMERA_HIT_RADIUS;
    const closestPoint = new THREE.Vector3();
    for (const ball of this.balls) {
      const closestY = THREE.MathUtils.clamp(ball.mesh.position.y, FLOOR_Y, this.camera.position.y);
      closestPoint.set(this.camera.position.x, closestY, this.camera.position.z);

      const delta = new THREE.Vector3().subVectors(ball.mesh.position, closestPoint);
      const dist = delta.length();
      if (dist === 0 || dist >= minDist) continue;

      const normal = delta.divideScalar(dist);
      const overlap = minDist - dist;
      ball.mesh.position.addScaledVector(normal, overlap);

      const incomingSpeed = ball.velocity.dot(normal);
      if (incomingSpeed >= 0) continue; // already moving away from the camera

      // Reflect the ball off the camera like a wall.
      ball.velocity.addScaledVector(normal, -(1 + WALL_RESTITUTION) * incomingSpeed);

      // Kick the camera in the direction the ball was heading (i.e. -normal,
      // since normal points from camera to ball), scaled by impact speed.
      const kickMag = Math.min(-incomingSpeed * CAMERA_KICK_SCALE, CAMERA_KICK_MAX);
      this._cameraKickOffset.addScaledVector(normal, -kickMag);
    }
  }

  /**
   * Fully tears down the scene: stops the loop, removes listeners, frees GPU resources.
   */
  dispose() {
    this.stop();
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("resize", this._onResize);
    this.canvas.removeEventListener("click", this._onCanvasClick);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.controls.unlock?.();

    for (const ball of this.balls) {
      ball.mesh.geometry.dispose();
      ball.mesh.material.map?.dispose();
      ball.mesh.material.dispose();
      this.scene.remove(ball.mesh);
    }
    this.balls = [];

    for (const wall of this.walls ?? []) {
      wall.geometry.dispose();
      wall.material.dispose();
      this.scene.remove(wall);
    }
    this.walls = [];

    for (const light of this.stadiumLights ?? []) {
      this.scene.remove(light.target);
      this.scene.remove(light);
    }
    this.stadiumLights = [];

    if (this.addButton) {
      const { group, knob } = this.addButton;
      for (const child of group.children) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          for (const m of child.material) {
            m.map?.dispose();
            m.dispose();
          }
        } else {
          child.material.map?.dispose();
          child.material.dispose();
        }
      }
      this.scene.remove(group);
      this.addButton = null;
    }

    this.renderer.dispose();
  }
}
