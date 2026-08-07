import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  bubbleLevelOffset,
  clamp,
  compassDirection,
  compassHeading,
  lowPassFilter,
  lowPassFilterVector,
  normalizeDegrees,
  run,
  tiltFromOrientation,
  vectorMagnitude,
} from './index';

describe('normalizeDegrees', () => {
  it('leaves an in-range angle untouched', () => {
    expect(normalizeDegrees(90)).toBe(90);
  });

  it('wraps a negative angle into range', () => {
    expect(normalizeDegrees(-10)).toBe(350);
  });

  it('wraps an angle past 360', () => {
    expect(normalizeDegrees(370)).toBe(10);
  });
});

describe('clamp', () => {
  it('passes through an in-range value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('compassHeading', () => {
  it('flips alpha into a clockwise compass heading', () => {
    // alpha 90 (device turned 90deg counter clockwise from start) -> heading 270
    expect(compassHeading(90)).toBe(270);
  });

  it('is 0 (north) when alpha is 360 (device pointing at start orientation)', () => {
    expect(compassHeading(360)).toBe(0);
  });

  it('subtracts the screen rotation angle', () => {
    expect(compassHeading(90, 90)).toBe(180);
  });
});

describe('compassDirection', () => {
  it('reads 0 degrees as north', () => {
    expect(compassDirection(0)).toBe('N');
  });

  it('reads 90 degrees as east', () => {
    expect(compassDirection(90)).toBe('E');
  });

  it('rounds a near-boundary heading to the nearest point', () => {
    expect(compassDirection(100)).toBe('E');
  });

  it('wraps 360 back to north', () => {
    expect(compassDirection(360)).toBe('N');
  });
});

describe('tiltFromOrientation', () => {
  it('reports zero magnitude when flat', () => {
    const tilt = tiltFromOrientation(0, 0);
    expect(tilt).toEqual({ pitch: 0, roll: 0, magnitude: 0 });
  });

  it('computes the Euclidean magnitude of pitch and roll', () => {
    const tilt = tiltFromOrientation(3, 4);
    expect(tilt.pitch).toBe(3);
    expect(tilt.roll).toBe(4);
    expect(tilt.magnitude).toBe(5);
  });

  it('clamps beta and gamma to their spec ranges', () => {
    const tilt = tiltFromOrientation(200, 120);
    expect(tilt.pitch).toBe(180);
    expect(tilt.roll).toBe(90);
  });
});

describe('bubbleLevelOffset', () => {
  it('sits centered when flat', () => {
    expect(bubbleLevelOffset(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('maps roll and pitch onto -1..1 within the max angle', () => {
    const offset = bubbleLevelOffset(22.5, -22.5, 45);
    expect(offset.y).toBeCloseTo(0.5, 5);
    expect(offset.x).toBeCloseTo(-0.5, 5);
  });

  it('saturates at the edges past the max angle', () => {
    const offset = bubbleLevelOffset(90, -90, 45);
    expect(offset.y).toBe(1);
    expect(offset.x).toBe(-1);
  });
});

describe('vectorMagnitude', () => {
  it('is zero for a zero vector', () => {
    expect(vectorMagnitude(0, 0, 0)).toBe(0);
  });

  it('computes a 3-4-12 right triangle in 3D (magnitude 13)', () => {
    expect(vectorMagnitude(3, 4, 12)).toBe(13);
  });

  it('handles negative components', () => {
    expect(vectorMagnitude(-3, -4, 0)).toBe(5);
  });
});

describe('lowPassFilter', () => {
  it('returns the raw value with no prior sample', () => {
    expect(lowPassFilter(null, 10, 0.25)).toBe(10);
  });

  it('moves partway toward the new sample by the smoothing weight', () => {
    expect(lowPassFilter(0, 10, 0.25)).toBe(2.5);
  });

  it('does not move at all with smoothing 0', () => {
    expect(lowPassFilter(5, 100, 0)).toBe(5);
  });

  it('tracks the raw signal exactly with smoothing 1', () => {
    expect(lowPassFilter(5, 100, 1)).toBe(100);
  });

  it('clamps an out-of-range smoothing factor', () => {
    expect(lowPassFilter(0, 10, 5)).toBe(10);
  });
});

describe('lowPassFilterVector', () => {
  it('smooths each axis independently', () => {
    const result = lowPassFilterVector({ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: -10 }, 0.5);
    expect(result).toEqual({ x: 5, y: 10, z: -5 });
  });

  it('returns the raw vector with no prior sample', () => {
    const result = lowPassFilterVector(null, { x: 1, y: 2, z: 3 }, 0.3);
    expect(result).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('run', () => {
  it('returns usage rows for empty input', () => {
    const out = run('');
    expect(out.Privacy).toContain('your files and inputs never leave your device');
  });

  it('computes heading, tilt and acceleration from a full snapshot', () => {
    const out = run(
      JSON.stringify({
        orientation: { alpha: 90, beta: 0, gamma: 0 },
        acceleration: { x: 0, y: 0, z: 9.8 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        rotationRate: { alpha: 1, beta: 2, gamma: 2 },
        ambientLight: 320,
      }),
    );
    expect(out.Heading).toBe('270° (W)');
    expect(out.Pitch).toBe('0°');
    expect(out.Roll).toBe('0°');
    expect(out['Acceleration (gravity removed)']).toContain('9.8 m/s²');
    expect(out['Acceleration (with gravity)']).toContain('9.8 m/s²');
    expect(out['Rotation rate']).toContain('deg/s');
    expect(out['Ambient light']).toBe('320 lux');
  });

  it('handles a partial snapshot with only acceleration', () => {
    const out = run(JSON.stringify({ acceleration: { x: 1, y: 0, z: 0 } }));
    expect(out.Heading).toBeUndefined();
    expect(out['Acceleration (gravity removed)']).toContain('1 m/s²');
  });

  it('throws for invalid JSON', () => {
    expect(() => run('{not json')).toThrow(ToolError);
  });

  it('throws for JSON that is not an object', () => {
    expect(() => run('[1,2,3]')).toThrow(ToolError);
  });

  it('throws for a snapshot with no recognized fields', () => {
    expect(() => run(JSON.stringify({ foo: 'bar' }))).toThrow(ToolError);
  });

  it('throws for an orientation field missing a numeric component', () => {
    expect(() => run(JSON.stringify({ orientation: { alpha: 1, beta: 2 } }))).toThrow(ToolError);
  });

  it('throws for an acceleration field with a non-numeric component', () => {
    expect(() => run(JSON.stringify({ acceleration: { x: 1, y: 'oops', z: 3 } }))).toThrow(
      ToolError,
    );
  });

  it('throws for a non-numeric screenAngle', () => {
    expect(() =>
      run(JSON.stringify({ orientation: { alpha: 1, beta: 2, gamma: 3 }, screenAngle: 'x' })),
    ).toThrow(ToolError);
  });

  it('throws for a non-numeric ambientLight', () => {
    expect(() => run(JSON.stringify({ ambientLight: 'bright' }))).toThrow(ToolError);
  });

  it('throws for a rotationRate field missing a numeric component', () => {
    expect(() => run(JSON.stringify({ rotationRate: { alpha: 1, beta: 2 } }))).toThrow(ToolError);
  });
});
