exports.up = (pgm) => {
  pgm.addColumn('financial_entries', {
    source_type: {
      type: 'text',
      default: 'manual'
    }
  }, {
    ifNotExists: true
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('financial_entries', 'source_type', {
    ifExists: true
  });
};
