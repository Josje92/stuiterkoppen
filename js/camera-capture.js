// Reusable face-capture interface.
// Shows a live front camera feed with a dark mask + see-through portrait oval,
// lets the user shoot a photo, confirm it or retake it, or cancel back out.

// Fixed portrait width:height ratio for the oval, kept constant on any screen shape.
// Exported so the 3D ball can be shaped as the same oval, stretched into an egg.
export const OVAL_ASPECT = 0.72;
// How much of the stage's available room the oval may fill (diameter, as a fraction).
const OVAL_FILL = 0.82;

const HINT_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be",
  "#30b0c7", "#007aff", "#5856d6", "#af52de", "#ff2d55",
];

export class CameraCapture {
  constructor() {
    this.overlay = document.getElementById("camera-overlay");
    this.stage = document.querySelector(".camera-stage");
    this.video = document.getElementById("camera-video");
    this.photoCanvas = document.getElementById("camera-photo-canvas");
    this.shootHint = document.getElementById("camera-shoot-hint");
    this.terugBtn = document.getElementById("camera-terug-btn");
    this.retryBtn = document.getElementById("camera-retry-btn");
    this.okBtn = document.getElementById("camera-ok-btn");
    this.confirmControls = document.getElementById("camera-confirm-controls");

    this.maskSvg = document.getElementById("camera-mask-svg");
    this.ovalCutout = document.getElementById("oval-cutout");
    this.ovalOutline = document.getElementById("oval-outline");

    this.stream = null;
    this._onCancel = null;
    this._onConfirm = null;
    this._skipConfirm = false;
    this._oval = { cx: 0, cy: 0, rx: 0, ry: 0 };

    this._onResize = () => this._layoutOval();
    this._onKeyDown = (e) => this._handleKeyDown(e);

    this._renderShootHint();

    this.retryBtn.addEventListener("click", () => this._retake());
    this.okBtn.addEventListener("click", () => this._confirm());
    this.terugBtn.addEventListener("click", () => this._cancel());
  }

  _renderShootHint() {
    const text = "Druk op de spatiebalk om je foto te maken";
    this.shootHint.innerHTML = "";
    [...text].forEach((char, i) => {
      const span = document.createElement("span");
      span.className = "letter";
      span.textContent = char;
      if (char !== " ") span.style.color = HINT_COLORS[i % HINT_COLORS.length];
      this.shootHint.appendChild(span);
    });
  }

  _handleKeyDown(event) {
    if (event.code !== "Space") return;
    if (this.video.classList.contains("hidden")) return; // already showing the confirm state
    event.preventDefault();
    this._takePhoto();
  }

  /**
   * Opens the camera capture interface.
   * @param {Object} opts
   * @param {(dataUrl: string) => void} opts.onConfirm - called with a photo data URL when the user confirms.
   * @param {() => void} opts.onCancel - called when the user presses "Terug".
   * @param {string} [opts.terugLabel] - overrides the cancel button's label.
   * @param {boolean} [opts.skipConfirm] - when true, hides the "Opnieuw"/"OK" step:
   *   pressing space shoots the photo and confirms it immediately.
   */
  async open({ onConfirm, onCancel, terugLabel = "Terug", skipConfirm = false } = {}) {
    this._onConfirm = onConfirm;
    this._onCancel = onCancel;
    this._skipConfirm = skipConfirm;
    this.terugBtn.textContent = terugLabel;

    this.overlay.classList.remove("hidden");
    this._showLiveState();
    this._layoutOval();
    window.addEventListener("resize", this._onResize);
    window.addEventListener("keydown", this._onKeyDown);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
    } catch (err) {
      console.error("Kon camera niet starten:", err);
      alert("Kon de camera niet openen. Controleer de camera-toestemming.");
      this._cancel();
    }
  }

  /**
   * Recomputes the oval's pixel geometry so it always keeps a fixed portrait
   * aspect ratio, regardless of the stage's own (landscape/portrait) shape.
   */
  _layoutOval() {
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    if (!stageW || !stageH) return;

    this.maskSvg.setAttribute("viewBox", `0 0 ${stageW} ${stageH}`);

    const ryFromHeight = (stageH * OVAL_FILL) / 2;
    const ryFromWidth = (stageW * OVAL_FILL) / 2 / OVAL_ASPECT;
    const ry = Math.min(ryFromHeight, ryFromWidth);
    const rx = ry * OVAL_ASPECT;
    const cx = stageW / 2;
    const cy = stageH / 2;

    this._oval = { cx, cy, rx, ry };

    for (const el of [this.ovalCutout, this.ovalOutline]) {
      el.setAttribute("cx", cx);
      el.setAttribute("cy", cy);
      el.setAttribute("rx", rx);
      el.setAttribute("ry", ry);
    }
  }

  _showLiveState() {
    this.video.classList.remove("hidden");
    this.photoCanvas.classList.add("hidden");
    this.shootHint.classList.remove("hidden");
    this.confirmControls.classList.add("hidden");
  }

  _showConfirmState() {
    this.video.classList.add("hidden");
    this.photoCanvas.classList.remove("hidden");
    this.shootHint.classList.add("hidden");
    this.confirmControls.classList.remove("hidden");
  }

  _takePhoto() {
    const video = this.video;
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;

    // The live preview uses object-fit: cover, centered, so the video is
    // scaled uniformly and cropped equally on all sides to fill the stage.
    const coverScale = Math.max(stageW / video.videoWidth, stageH / video.videoHeight);

    // Because both the oval and the covered video share the same center,
    // the oval's bounding box maps straight to a centered crop in source pixels.
    const cropW = (this._oval.rx * 2) / coverScale;
    const cropH = (this._oval.ry * 2) / coverScale;
    const cropX = video.videoWidth / 2 - cropW / 2;
    const cropY = video.videoHeight / 2 - cropH / 2;

    const canvas = this.photoCanvas;
    canvas.width = Math.round(cropW);
    canvas.height = Math.round(cropH);
    // Display the photo at the oval's on-screen size, so it looks the same
    // scale it did while live instead of being blown up to fill the stage.
    canvas.style.width = `${this._oval.rx * 2}px`;
    canvas.style.height = `${this._oval.ry * 2}px`;

    const ctx = canvas.getContext("2d");
    // Mirror horizontally to match the mirrored live preview.
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (this._skipConfirm) {
      this._confirm();
    } else {
      this._showConfirmState();
    }
  }

  _retake() {
    this._showLiveState();
  }

  _confirm() {
    const dataUrl = this.photoCanvas.toDataURL("image/png");
    this._close();
    if (this._onConfirm) this._onConfirm(dataUrl);
  }

  _cancel() {
    this._close();
    if (this._onCancel) this._onCancel();
  }

  _close() {
    this.overlay.classList.add("hidden");
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKeyDown);
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}
