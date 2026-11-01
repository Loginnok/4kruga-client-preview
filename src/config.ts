import catalog from '../prisma/official-catalog.json' with {type:'json'};
export const storeConfig = Object.freeze({
  name:"4 круга",
  phone:catalog.contacts.phone,
  phoneHref:catalog.contacts.phoneHref,
  email:catalog.contacts.email,
  address:catalog.contacts.address,
  hours:catalog.contacts.hours,
  catalogSnapshotAt:catalog.retrievedAt,
  localNotice:"Локальное приложение. Тестовый ассортимент; заказы и заявки не передаются магазину. Реальной оплаты нет.",
  consentVersion:"local-processing-2026-10-28",
});
