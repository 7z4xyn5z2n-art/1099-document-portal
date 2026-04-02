exports.up = (pgm) => {
  pgm.createTable('financial_entries', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()')
    },
    contractor_id: {
      type: 'uuid',
      notNull: true
    },
    document_id: {
      type: 'uuid'
    },
    entry_type: {
      type: 'text',
      notNull: true
    },
    entry_date: {
      type: 'date'
    },
    amount: {
      type: 'numeric'
    },
    category: {
      type: 'text'
    },
    description: {
      type: 'text'
    },
    vendor_or_payor: {
      type: 'text'
    },
    source_type: {
      type: 'text',
      default: 'manual'
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('now()')
    }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('financial_entries');
};
