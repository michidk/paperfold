import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { equipHat, placeHat } from './hats'

test('equipping and removing a hat leaves the paper geometry unchanged', () => {
  const geometry = new THREE.BoxGeometry(0.2, 0.01, 0.1)
  const material = new THREE.MeshBasicMaterial()
  const plane = new THREE.Mesh(geometry, material)
  const positions = [...geometry.getAttribute('position').array]
  equipHat(plane, 'top-hat')
  const topHat = plane.getObjectByName('equippedHat')
  expect(topHat?.position.y).toBeCloseTo(0.01)
  expect(plane.geometry).toBe(geometry)
  expect([...geometry.getAttribute('position').array]).toEqual(positions)
  equipHat(plane, 'wizard-hat')
  expect(plane.children).toHaveLength(1)
  expect(topHat?.parent).toBeNull()
  geometry.translate(0, 0.1, 0)
  placeHat(plane)
  expect(plane.getObjectByName('equippedHat')?.position.y).toBeCloseTo(0.11)
  equipHat(plane, null)
  expect(plane.children).toHaveLength(0)
  geometry.dispose()
  material.dispose()
})
