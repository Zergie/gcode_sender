// Custom plugin to draw crosshair
let mousePosition = { x: null, y: null };
let mouseClicks = [];
exports.crosshairPlugin = {
  id: 'crosshair',
  afterEvent(chart, args) {
    const e = args.event;
    switch (e.type) {
      case 'mousemove':
        mousePosition.x = e.x;
        mousePosition.y = e.y;
        chart.draw(); // Redraw chart to show crosshair
        break;
      case 'mouseout':
        mousePosition.x = null;
        mousePosition.y = null;
        chart.draw(); // Clear crosshair
        break;
      case 'click':
        // const point = {
        //   x: chart.scales.x.getValueForPixel(e.x),
        //   y: chart.scales.y.getValueForPixel(e.y),
        // };
        // if (mouseClicks.length >= 2) {
        //   mouseClicks = [point];
        // } else if (mouseClicks.length == 1 && mouseClicks[0].x == e.x) {
        //   mouseClicks = [];
        // } else {
        //   mouseClicks.push(point);
        // }
        break;
    }
  },
  afterDraw(chart) {

    const ctx = chart.ctx;
    const { x, y } = mousePosition;

    ctx.save();

    if (mousePosition.x !== null || mousePosition.y !== null) {
      ctx.beginPath();
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, chart.height);
      ctx.moveTo(0, y);
      ctx.lineTo(chart.width, y);
      ctx.stroke();
    }

    if (mouseClicks.length > 0) {
      const x1 = chart.scales.x.getPixelForValue(mouseClicks[0].x);
      const y1 = chart.scales.y.getPixelForValue(mouseClicks[0].y);
      const x2 = mouseClicks.length == 1 ? x : chart.scales.x.getPixelForValue(mouseClicks[1].x);
      const x_text = Math.min(x1, x2) + (Math.max(x1, x2) - Math.min(x1, x2)) / 2;
      const y_text = y1 - 15;
      const x_diff = chart.scales.x.getValueForPixel(Math.max(x1, x2)) - chart.scales.x.getValueForPixel(Math.min(x1, x2));

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'yellow';
      ctx.lineWidth = 1;
      ctx.lineTo(x1, y1 - 10);
      ctx.lineTo(x2, y1 - 10);
      ctx.lineTo(x2, y1);
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.font = 'bold 12px Roboto';
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.fillStyle = 'yellow';
      const text = `${x_diff.toFixed(1)} s`;
      ctx.strokeText(text, x_text, y_text);
      ctx.fillText(text, x_text, y_text);
    }

    ctx.restore();
  }
};
