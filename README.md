# Billar 3D

Juego de billar (bola 8) en el navegador. Vite + TypeScript + Three.js, con física propia.

## Arrancar

```bash
npm install
npm run dev
```

## Controles

- **Ratón**: apuntar
- **Mantener clic izquierdo**: cargar potencia; soltar para tirar
- **← / →**: ajuste fino del ángulo (con Shift, más fino)
- **Clic derecho + arrastrar**: girar la cámara · **Rueda**: zoom
- **V**: cámara detrás de la bola blanca

## Estructura

- `src/physics.ts` — física 2D sobre el plano de la mesa (rodadura, choques, bandas, troneras)
- `src/rules.ts` — reglas simplificadas de bola 8 (grupos, faltas, bola en mano)
- `src/table.ts` — mesa, sala e iluminación
- `src/balls.ts` — bolas (texturas generadas en canvas) y taco
- `src/audio.ts` — sonidos sintetizados con WebAudio
- `src/main.ts` — escena, entrada y bucle de juego
