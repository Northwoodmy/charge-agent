import React from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

// 端口配色（Candy 色系）
export const PORT_COLORS = ['#58696a', '#ec5631', '#e8902a', '#3a7d4d', '#8a6fb8'];

export default function PowerChart({ series, height = 280 }) {
  const ref = React.useRef(null);
  const plotRef = React.useRef(null);

  React.useEffect(() => {
    if (!ref.current) return;
    // 统一时间轴：各端口采样时间可能不齐，取并集，缺失补 null
    const tsSet = new Set();
    for (const s of series) for (const p of s.points) tsSet.add(p[0]);
    const x = [...tsSet].sort((a, b) => a - b);
    const data = [
      x,
      ...series.map((s) => {
        const map = new Map(s.points);
        return x.map((t) => (map.has(t) ? map.get(t) : null));
      }),
    ];
    const opts = {
      width: ref.current.clientWidth,
      height,
      padding: [10, 0, 0, 0],
      legend: { show: false },
      cursor: { show: true, drag: { x: false, y: false } },
      scales: { x: { time: true } },
      axes: [
        {
          stroke: '#5b574f', grid: { stroke: 'rgba(22,22,19,0.08)', width: 1 },
          ticks: { stroke: 'rgba(22,22,19,0.22)', width: 1 },
          font: '11px ui-monospace, Menlo, monospace',
          values: (u, splits) => splits.map((s) => new Date(s * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
        },
        {
          stroke: '#5b574f', grid: { stroke: 'rgba(22,22,19,0.08)', width: 1 },
          ticks: { stroke: 'rgba(22,22,19,0.22)', width: 1 },
          font: '11px ui-monospace, Menlo, monospace', size: 52,
          values: (u, splits) => splits.map((s) => s + ' W'),
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          stroke: s.color, width: 2,
          points: { show: false },
        })),
      ],
    };
    plotRef.current?.destroy();
    if (x.length > 1) {
      plotRef.current = new uPlot(opts, data, ref.current);
    }
    const onResize = () => plotRef.current?.setSize({ width: ref.current.clientWidth, height });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [series, height]);

  return <div className="chart-wrap" ref={ref} />;
}
