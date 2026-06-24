export interface ZoomConfig {
  pixelsPerSecond: number;
  majorInterval: number;
  minorDivisions: number;
}

export const ZOOM_CONFIGS: ZoomConfig[] = [
  { pixelsPerSecond: 2, majorInterval: 120, minorDivisions: 12 },
  { pixelsPerSecond: 5, majorInterval: 60, minorDivisions: 12 },
  { pixelsPerSecond: 8, majorInterval: 30, minorDivisions: 6 },
  { pixelsPerSecond: 12, majorInterval: 30, minorDivisions: 6 },
  { pixelsPerSecond: 18, majorInterval: 15, minorDivisions: 3 },
  { pixelsPerSecond: 25, majorInterval: 10, minorDivisions: 5 },
  { pixelsPerSecond: 35, majorInterval: 10, minorDivisions: 10 },
  { pixelsPerSecond: 50, majorInterval: 5, minorDivisions: 5 },
  { pixelsPerSecond: 70, majorInterval: 5, minorDivisions: 5 },
  { pixelsPerSecond: 100, majorInterval: 2, minorDivisions: 4 },
  { pixelsPerSecond: 150, majorInterval: 1, minorDivisions: 2 },
  { pixelsPerSecond: 200, majorInterval: 1, minorDivisions: 4 },
  { pixelsPerSecond: 300, majorInterval: 1, minorDivisions: 5 },
  { pixelsPerSecond: 500, majorInterval: 0.5, minorDivisions: 5 },
];

export function getZoomConfig(zoom: number): ZoomConfig {
    return ZOOM_CONFIGS.reduce((prev, curr) => 
        Math.abs(curr.pixelsPerSecond - zoom) < Math.abs(prev.pixelsPerSecond - zoom) ? curr : prev
    );
}

export function getNextZoom(currentZoom: number): number {
    let closestIdx = -1;
    let minDiff = Infinity;
    
    ZOOM_CONFIGS.forEach((cfg, idx) => {
        const diff = Math.abs(cfg.pixelsPerSecond - currentZoom);
        if (diff < minDiff) {
            minDiff = diff;
            closestIdx = idx;
        }
    });
    
    const targetIdx = Math.min(ZOOM_CONFIGS.length - 1, closestIdx + 1);
    if (ZOOM_CONFIGS[closestIdx].pixelsPerSecond < currentZoom && closestIdx < ZOOM_CONFIGS.length - 1) {
        return ZOOM_CONFIGS[closestIdx + 1].pixelsPerSecond;
    }

    return ZOOM_CONFIGS[targetIdx].pixelsPerSecond;
}

export function getPrevZoom(currentZoom: number): number {
    let closestIdx = -1;
    let minDiff = Infinity;
    
    ZOOM_CONFIGS.forEach((cfg, idx) => {
        const diff = Math.abs(cfg.pixelsPerSecond - currentZoom);
        if (diff < minDiff) {
            minDiff = diff;
            closestIdx = idx;
        }
    });

    if (ZOOM_CONFIGS[closestIdx].pixelsPerSecond < currentZoom) {
        return ZOOM_CONFIGS[closestIdx].pixelsPerSecond;
    }

    const targetIdx = Math.max(0, closestIdx - 1);
    return ZOOM_CONFIGS[targetIdx].pixelsPerSecond;
}
