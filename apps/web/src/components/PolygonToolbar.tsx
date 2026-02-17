type DrawingState = "idle" | "drawing" | "complete";

interface PolygonToolbarProps {
  drawingState: DrawingState;
  vertexCount: number;
  onStartDraw: () => void;
  onFinishDraw: () => void;
  onClear: () => void;
  onExport?: () => void;
}

export function PolygonToolbar({
  drawingState,
  vertexCount,
  onStartDraw,
  onFinishDraw,
  onClear,
  onExport,
}: PolygonToolbarProps) {
  return (
    <div className="polygon-toolbar">
      {drawingState === "idle" && (
        <button className="poly-btn" onClick={onStartDraw}>
          Draw Polygon
        </button>
      )}
      {drawingState === "drawing" && (
        <>
          <span className="poly-info">{vertexCount} vertices</span>
          <button
            className="poly-btn"
            onClick={onFinishDraw}
            disabled={vertexCount < 3}
          >
            Finish
          </button>
          <button className="poly-btn poly-btn-cancel" onClick={onClear}>
            Cancel
          </button>
        </>
      )}
      {drawingState === "complete" && (
        <>
          <button className="poly-btn poly-btn-cancel" onClick={onClear}>
            Clear Polygon
          </button>
          {onExport && (
            <button className="poly-btn poly-btn-export" onClick={onExport}>
              Export PDF
            </button>
          )}
        </>
      )}
    </div>
  );
}
