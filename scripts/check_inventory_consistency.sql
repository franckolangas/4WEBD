-- Controle simple de coherence stock pour un evenement donne
-- Remplacer :event_id par l'UUID cible

WITH r AS (
  SELECT
    event_id,
    COALESCE(SUM(quantity) FILTER (WHERE status IN ('PENDING','CONFIRMED')), 0) AS reserved_qty
  FROM seat_reservations
  WHERE event_id = :event_id
  GROUP BY event_id
)
SELECT
  e.id,
  e.total_capacity,
  e.available_capacity,
  COALESCE(r.reserved_qty, 0) AS reserved_qty,
  (e.total_capacity - COALESCE(r.reserved_qty, 0)) AS expected_available,
  CASE
    WHEN e.available_capacity = (e.total_capacity - COALESCE(r.reserved_qty, 0)) THEN 'OK'
    ELSE 'MISMATCH'
  END AS consistency
FROM events e
LEFT JOIN r ON r.event_id = e.id
WHERE e.id = :event_id;
