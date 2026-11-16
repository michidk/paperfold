import * as THREE from 'three'
import { HATS, type HatId } from '../shared/items'

export function createHat(id: HatId) {
  const group = new THREE.Group()
  const color = HATS.find((hat) => hat.id === id)?.color ?? 0xffffff
  const part = (
    geometry: THREE.BufferGeometry,
    tint: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshToonMaterial({ color: tint }),
    )
    mesh.position.set(x, y, z)
    group.add(mesh)
    return mesh
  }
  if (id === 'top-hat') {
    part(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 24), color, 0, 0.04, 0)
    part(new THREE.CylinderGeometry(0.37, 0.4, 0.7, 24), color, 0, 0.43, 0)
    part(
      new THREE.CylinderGeometry(0.398, 0.405, 0.13, 24),
      0xff6b6b,
      0,
      0.16,
      0,
    )
  } else if (id === 'wizard-hat') {
    part(new THREE.CylinderGeometry(0.65, 0.65, 0.07, 24), color, 0, 0.035, 0)
    part(new THREE.ConeGeometry(0.43, 1.1, 24), color, 0, 0.6, 0)
    part(new THREE.CylinderGeometry(0.39, 0.43, 0.1, 24), 0xffd166, 0, 0.12, 0)
    part(new THREE.SphereGeometry(0.07, 12, 8), 0xffd166, 0.28, 0.4, 0)
  } else {
    part(
      new THREE.CylinderGeometry(0.46, 0.4, 0.3, 24, 1, true),
      color,
      0,
      0.15,
      0,
    )
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3
      part(
        new THREE.ConeGeometry(0.15, 0.35, 4),
        color,
        0.4 * Math.cos(angle),
        0.4,
        0.4 * Math.sin(angle),
      )
      part(
        new THREE.SphereGeometry(0.065, 10, 8),
        i % 2 ? 0xff6b6b : 0x5fb6db,
        0.45 * Math.cos(angle),
        0.17,
        0.45 * Math.sin(angle),
      )
    }
  }
  return group
}

export function placeHat(plane: THREE.Mesh<THREE.BufferGeometry>) {
  const hat = plane.getObjectByName('equippedHat')
  if (!hat) return
  plane.geometry.computeBoundingBox()
  hat.position.set(0, (plane.geometry.boundingBox?.max.y ?? 0) + 0.005, 0)
}

export function equipHat(
  plane: THREE.Mesh<THREE.BufferGeometry>,
  id: HatId | null,
) {
  const previous = plane.getObjectByName('equippedHat')
  if (previous) {
    previous.traverse((part) => {
      if (part instanceof THREE.Mesh) {
        part.geometry.dispose()
        const materials = Array.isArray(part.material)
          ? part.material
          : [part.material]
        for (const material of materials) material.dispose()
      }
    })
    previous.removeFromParent()
  }
  if (!id) return
  const hat = createHat(id)
  hat.name = 'equippedHat'
  hat.scale.setScalar(0.045)
  plane.add(hat)
  placeHat(plane)
}
