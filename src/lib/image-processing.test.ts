import { describe, expect, it } from 'vitest'
import {
  defaultCorners,
  perspectiveCoefficients,
  polygonArea,
  projectPoint,
} from './image-processing'
import type { Point } from '../types'

describe('perspective geometry', () => {
  it('keeps the default page as a unit square', () => {
    expect(polygonArea(defaultCorners())).toBe(1)
  })

  it('maps all destination corners to a skewed source quadrilateral', () => {
    const destination: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
    ]
    const source: Point[] = [
      { x: 12, y: 20 },
      { x: 92, y: 5 },
      { x: 100, y: 198 },
      { x: 2, y: 180 },
    ]
    const coefficients = perspectiveCoefficients(destination, source)
    destination.forEach((point, index) => {
      expect(projectPoint(point, coefficients).x).toBeCloseTo(source[index].x, 5)
      expect(projectPoint(point, coefficients).y).toBeCloseTo(source[index].y, 5)
    })
  })
})
