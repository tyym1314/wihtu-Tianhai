/** Viewport-only reel painting. Server cells and reel timing remain owned by GameMotion. */
export type ReelCell = { symbol: string; multiplier?: number };
type Sprite = { x: number; y: number; sizeX: number; sizeY: number };
type Tile = HTMLCanvasElement | ImageBitmap;
const SYMBOLS = ['sapphire', 'emerald', 'ruby', 'amethyst', 'pearl', 'amber', 'crown', 'chalice', 'scatter'];

export class ReelAtlas {
  private image: HTMLImageElement | null = null;
  private sprites = new Map<string, Sprite>();
  private tiles = new Map<string, Tile>();
  private loading = false;
  private disposed = false;
  private width = 0;
  private height = 0;
  private ratio = 0;
  private pool: HTMLCanvasElement[] = [];
  private cacheRevision = 0;
  private building = false;

  constructor(private board: HTMLElement, private markup: (symbol: string, multiplier?: number) => string) {}

  prepare(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 1) return;
    const ratio = devicePixelRatio || 1;
    if (width === this.width && height === this.height && ratio === this.ratio && (this.tiles.size || this.loading || this.building)) return;
    this.width = width; this.height = height; this.ratio = ratio;
    if (this.image) { this.makeTiles(); return; }
    if (this.loading) return;
    this.loading = true;
    // Resolve the actual CSS resource (including the release mobile WebP rewrite),
    // rather than introducing a second atlas URL or a second crop definition.
    const sample = document.createElement('div');
    sample.className = 'motion-reel-symbol';
    sample.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:1px';
    this.board.appendChild(sample);
    let url = '';
    try {
      for (const symbol of SYMBOLS) {
        sample.innerHTML = this.markup(symbol);
        const art = sample.querySelector<HTMLElement>('.symbol-art');
        if (!art) throw new Error('Reel artwork unavailable');
        const style = getComputedStyle(art);
        const match = /^url\(["']?(.*?)["']?\)$/.exec(style.backgroundImage);
        const size = style.backgroundSize.split(/\s+/).map(value => parseFloat(value) / 100);
        const position = art.style.backgroundPosition.split(/\s+/).map(value => parseFloat(value) / 100);
        if (!match || size.length !== 2 || !size.every(value => value > 1) || position.length !== 2 || !position.every(Number.isFinite)) throw new Error('Reel artwork geometry unavailable');
        if (url && url !== match[1]) throw new Error('Reel artwork uses different atlases');
        url = match[1];
        this.sprites.set(symbol, { x: position[0], y: position[1], sizeX: size[0], sizeY: size[1] });
      }
    } catch {
      this.loading = false; this.sprites.clear(); return;
    } finally { sample.remove(); }
    const image = new Image();
    image.src = url;
    void image.decode().then(() => {
      if (this.disposed) return;
      this.image = image;
      this.makeTiles();
    }).catch(() => { this.tiles.clear(); }).finally(() => { this.loading = false; });
  }

  private makeTiles(): void {
    const image = this.image;
    if (!image || this.disposed) return;
    const revision = ++this.cacheRevision;
    const width = this.width, height = this.height;
    const tiles = new Map<string, HTMLCanvasElement>();
    for (const symbol of [...SYMBOLS, 'multiplier']) {
      const tile = document.createElement('canvas');
      tile.width = Math.max(1, Math.ceil(width * this.ratio));
      tile.height = Math.max(1, Math.ceil(height * this.ratio));
      const context = tile.getContext('2d');
      // A failed resize rebuild must not drop the last complete cache while a
      // reel is displaying it. Initial failure still leaves the DOM fallback.
      if (!context) { this.building = false; return; }
      context.setTransform(tile.width / width, 0, 0, tile.height / height, 0, 0);
      // Same farthest-corner ellipse and stops as .motion-reel-symbol.
      context.save();
      context.translate(width * .5, height * .35);
      context.scale(width * .5, height * .65);
      const gradient = context.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
      gradient.addColorStop(0, '#192b4b'); gradient.addColorStop(.78, '#07111e');
      context.fillStyle = gradient;
      context.fillRect(-1, -.35 / .65, 2, 1 / .65);
      context.restore();
      const sprite = this.sprites.get(symbol);
      if (sprite) {
        const sw = image.naturalWidth / sprite.sizeX, sh = image.naturalHeight / sprite.sizeY;
        context.globalCompositeOperation = 'lighten';
        context.drawImage(image, (image.naturalWidth - sw) * sprite.x, (image.naturalHeight - sh) * sprite.y, sw, sh,
          width * .03, (height - 1) * .03, width * .94, (height - 1) * .94);
        context.globalCompositeOperation = 'source-over';
      }
      context.fillStyle = '#c5a45e2b'; context.fillRect(0, height - 1, width, 1);
      tiles.set(symbol, tile);
    }
    // Materialize immutable sprites during preparation, before the paid gesture.
    // No readback, image decode or atlas compositing belongs in the frame loop.
    this.building = true;
    const prepare = typeof createImageBitmap === 'function'
      ? Promise.allSettled([...tiles].map(async ([symbol, tile]) => [symbol, await createImageBitmap(tile)] as const))
      : Promise.resolve([]);
    void prepare.then(results => {
      const bitmaps = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (this.disposed || revision !== this.cacheRevision) { bitmaps.forEach(([, bitmap]) => bitmap.close()); return; }
      this.tiles.forEach(tile => { if ('close' in tile) tile.close(); });
      if (bitmaps.length === tiles.size) this.tiles = new Map(bitmaps);
      else { bitmaps.forEach(([, bitmap]) => bitmap.close()); this.tiles = tiles; }
      this.building = false;
      while (this.pool.length < 6) this.pool.push(document.createElement('canvas'));
    });
  }

  get ready(): boolean { return this.tiles.size === SYMBOLS.length + 1; }
  tile(symbol: string): Tile | undefined { return this.tiles.get(symbol) ?? this.tiles.get('sapphire'); }

  viewport(reel: HTMLElement, width: number, height: number, viewportHeight: number): ReelViewport | null {
    if (!this.ready) return null;
    const canvas = this.pool.pop() ?? document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    return new ReelViewport(this, reel, canvas, context, this.markup, width, height, viewportHeight);
  }

  recycle(canvas: HTMLCanvasElement): void { canvas.remove(); if (!this.disposed && this.pool.length < 6) this.pool.push(canvas); }
  dispose(): void {
    this.disposed = true; this.cacheRevision++;
    this.tiles.forEach(tile => { if ('close' in tile) tile.close(); });
    this.tiles.clear(); this.pool = []; this.image = null;
  }
}

export class ReelViewport {
  private cells: ReelCell[] = [];
  private badges: { row: number; element: HTMLElement }[] = [];
  private width = 0;
  private height = 0;
  private viewportHeight = 0;

  constructor(private atlas: ReelAtlas, private reel: HTMLElement, private canvas: HTMLCanvasElement,
    private context: CanvasRenderingContext2D, private markup: (symbol: string, multiplier?: number) => string,
    width: number, height: number, viewportHeight: number) {
    canvas.className = 'motion-reel-viewport';
    canvas.setAttribute('aria-hidden', 'true');
    reel.classList.add('motion-reel-raster');
    reel.appendChild(canvas);
    this.resize(width, height, viewportHeight);
  }

  resize(width: number, height: number, viewportHeight: number): void {
    this.width = width; this.height = height; this.viewportHeight = viewportHeight;
    const ratio = devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.ceil(width * ratio)), pixelHeight = Math.max(1, Math.ceil(viewportHeight * ratio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.context.setTransform(pixelWidth / width, 0, 0, pixelHeight / viewportHeight, 0, 0);
    for (const badge of this.badges) badge.element.style.height = `${height}px`;
  }

  setCells(cells: ReelCell[]): void {
    this.cells = cells;
    this.badges.forEach(badge => badge.element.remove()); this.badges = [];
    cells.forEach((cell, row) => {
      if (cell.symbol !== 'multiplier') return;
      // Keep the real badge's exact font, value and orb styling; decorative rows
      // never create badges or per-symbol compositing surfaces.
      const element = document.createElement('div');
      element.className = 'motion-reel-symbol motion-reel-badge symbol-multiplier';
      element.style.height = `${this.height}px`;
      element.innerHTML = this.markup(cell.symbol, cell.multiplier);
      this.reel.appendChild(element); this.badges.push({ row, element });
    });
  }

  draw(offsetRows: number): void {
    const { context, width, height, viewportHeight } = this;
    context.clearRect(0, 0, width, viewportHeight);
    // Crop to the same fixed reel window instead of rasterizing 12/15 rows.
    const first = Math.max(0, Math.floor(-offsetRows));
    const last = Math.min(this.cells.length, Math.ceil(viewportHeight / height - offsetRows));
    for (let row = first; row < last; row++) {
      const tile = this.atlas.tile(this.cells[row].symbol);
      if (tile) context.drawImage(tile, 0, 0, tile.width, tile.height, 0, (row + offsetRows) * height, width, height);
    }
    for (const badge of this.badges) {
      const y = (badge.row + offsetRows) * height;
      badge.element.style.visibility = y < viewportHeight && y + height > 0 ? 'visible' : 'hidden';
      badge.element.style.transform = `translate3d(0,${y}px,0)`;
    }
  }

  dispose(): void { this.badges.forEach(badge => badge.element.remove()); this.badges = []; this.atlas.recycle(this.canvas); }
}
